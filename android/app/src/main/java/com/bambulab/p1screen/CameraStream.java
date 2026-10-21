package com.bambulab.p1screen;

import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.Log;
import android.view.Surface;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Pulls the printer camera over RTSP/TLS
 * (rtsps://bblp:&lt;access code&gt;@&lt;ip&gt;:322/streaming/live/1) using TCP
 * interleaved transport, decodes the H.264 payload with MediaCodec and keeps the
 * most recent frame as a JPEG in memory.
 *
 * Written without third-party libraries on purpose: ffmpeg-kit / mobile-ffmpeg
 * were removed from Maven Central, and GitHub is not reachable from the build
 * environment.
 */
final class CameraStream {
  private static final String TAG = "CameraStream";
  private static final int RTSP_PORT = 322;
  private static final String RTSP_PATH = "/streaming/live/1";
  private static final String RTSP_USER = "bblp";
  private static final int CONNECT_TIMEOUT_MS = 8000;
  private static final int SO_TIMEOUT_MS = 20000;
  private static final long MIN_FRAME_INTERVAL_MS = 100;
  private static final int JPEG_QUALITY = 65;
  private static final int MAX_RETRIES = 6;
  private static final long RETRY_DELAY_MS = 3000L;
  private static final long KEEPALIVE_INTERVAL_MS = 20000L;

  private final String serial;
  private final String host;
  private final String accessCode;

  private final AtomicBoolean running = new AtomicBoolean(false);
  private final AtomicReference<byte[]> latestJpeg = new AtomicReference<>(null);
  private volatile String status = "idle";
  private volatile long lastFrameAt = 0L;
  private Thread worker;

  CameraStream(String serial, String host, String accessCode) {
    this.serial = serial;
    this.host = host;
    this.accessCode = accessCode;
  }

  String getSerial() {
    return serial;
  }

  String getStatus() {
    return status;
  }

  byte[] getLatestJpeg() {
    return latestJpeg.get();
  }

  synchronized void start() {
    if (running.get()) return;
    running.set(true);
    worker = new Thread(this::runStream, "camera-" + serial);
    worker.setDaemon(true);
    worker.start();
  }

  synchronized void stop() {
    running.set(false);
    Thread thread = worker;
    worker = null;
    if (thread != null) thread.interrupt();
    status = "idle";
    latestJpeg.set(null);
  }

  boolean isRunning() {
    return running.get();
  }

  // ---------------------------------------------------------------- lifecycle

  private void runStream() {
    int attempt = 0;
    while (running.get() && attempt < MAX_RETRIES) {
      attempt++;
      try {
        streamOnce();
        // clean exit = the stream ended; retry unless we were asked to stop
        if (!running.get()) break;
        status = "reconnecting";
      } catch (Exception e) {
        if (!running.get()) break;
        status = "error:" + describe(e);
        Log.w(TAG, "[" + serial + "] stream failed (attempt " + attempt + ")", e);
      }
      if (attempt >= MAX_RETRIES) {
        status = "error:stream ended";
        break;
      }
      try {
        Thread.sleep(RETRY_DELAY_MS);
      } catch (InterruptedException ie) {
        Thread.currentThread().interrupt();
        break;
      }
    }
    if (running.get()) Log.w(TAG, "[" + serial + "] giving up after " + attempt + " attempts");
  }

  private static String describe(Exception e) {
    String msg = e.getMessage();
    if (msg == null || msg.isEmpty()) return e.getClass().getSimpleName();
    return msg.length() > 120 ? msg.substring(0, 120) : msg;
  }

  private void streamOnce() throws Exception {
    status = "connecting";
    SSLSocketFactory factory = createTrustAllSocketFactory();
    Socket socket = factory.createSocket();
    try {
      socket.connect(new InetSocketAddress(host, RTSP_PORT), CONNECT_TIMEOUT_MS);
      socket.setSoTimeout(SO_TIMEOUT_MS);
      InputStream in = socket.getInputStream();
      OutputStream out = socket.getOutputStream();

      String baseUrl = "rtsp://" + host + ":" + RTSP_PORT + RTSP_PATH;
      AuthState auth = new AuthState();
      CseqCounter cseq = new CseqCounter();

      RtspResponse describe = request(out, in, "DESCRIBE", baseUrl,
        "Accept: application/sdp\r\n", auth, null, cseq);
      if (describe.code != 200) {
        throw new IOException("DESCRIBE failed: " + describe.code);
      }
      TrackInfo track = parseSdp(describe.body, baseUrl);

      String transport = "RTP/AVP/TCP;unicast;interleaved=0-1";
      RtspResponse setup = request(out, in, "SETUP", track.controlUrl,
        "Transport: " + transport + "\r\n", auth, null, cseq);
      if (setup.code != 200 && setup.code != 201) {
        throw new IOException("SETUP failed: " + setup.code);
      }
      String session = setup.headers.get("session");
      if (session != null && session.indexOf(';') > 0) {
        session = session.substring(0, session.indexOf(';'));
      }
      int[] channels = parseInterleaved(setup.headers.get("transport"));

      RtspResponse play = request(out, in, "PLAY", baseUrl,
        "Range: npt=0.000-\r\n", auth, session, cseq);
      if (play.code != 200) {
        throw new IOException("PLAY failed: " + play.code);
      }

      status = "streaming";
      readLoop(in, out, baseUrl, session, channels, track);
    } finally {
      try {
        socket.close();
      } catch (IOException ignored) {
      }
    }
  }

  // ------------------------------------------------------------- data reading

  private void readLoop(InputStream in, OutputStream out, String baseUrl, String session,
                        int[] channels, TrackInfo track) throws IOException {
    MediaCodec codec = null;
    ImageReader reader = null;
    HandlerThread imageThread = null;

    try {
      if (track.width > 0 && track.height > 0) {
        imageThread = new HandlerThread("camera-images-" + serial);
        imageThread.start();
        reader = ImageReader.newInstance(track.width, track.height, ImageFormat.YUV_420_888, 3);
        final ImageReader finalReader = reader;
        final AtomicBoolean active = running;
        reader.setOnImageAvailableListener(imageReader -> {
          if (!active.get()) return;
          onFrameAvailable(imageReader);
        }, new Handler(imageThread.getLooper()));

        MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC,
          track.width, track.height);
        if (track.sps != null) format.setByteBuffer("csd-0", ByteBuffer.wrap(track.sps));
        if (track.pps != null) format.setByteBuffer("csd-1", ByteBuffer.wrap(track.pps));
        codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        codec.configure(format, reader.getSurface(), null, 0);
        codec.start();
      } else {
        Log.w(TAG, "[" + serial + "] no video size in SDP");
      }

      FuReassembler fu = new FuReassembler();
      long keepaliveAt = System.currentTimeMillis() + KEEPALIVE_INTERVAL_MS;
      long ptsUs = 0L;
      MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();

      while (running.get()) {
        int marker = in.read();
        if (marker < 0) throw new EOFException("stream closed");
        if (marker != '$') {
          // Stray RTSP response interleaved - drain the line and continue.
          continue;
        }
        int channel = in.read();
        if (channel < 0) throw new EOFException("stream closed");
        int length = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
        if (length < 0) throw new EOFException("stream closed");
        byte[] packet = readFully(in, length);

        if (channel != channels[0]) continue; // RTCP / control channel

        byte[] nal = extractNal(packet, fu);
        if (nal == null || codec == null) continue;

        int nalType = nal[0] & 0x1F;
        if (nalType == 7) {
          track.sps = nal;
          continue;
        }
        if (nalType == 8) {
          track.pps = nal;
          continue;
        }

        byte[] accessUnit = nal;
        if (nalType == 5 || nalType == 1) {
          boolean isIdr = nalType == 5;
          accessUnit = withParameterSets(track, nal, isIdr);
        }

        int inputIndex = codec.dequeueInputBuffer(10000L);
        if (inputIndex >= 0) {
          ByteBuffer buffer = codec.getInputBuffer(inputIndex);
          if (buffer != null) {
            buffer.clear();
            buffer.put(accessUnit);
            ptsUs += 33333L;
            codec.queueInputBuffer(inputIndex, 0, accessUnit.length, ptsUs, 0);
          }
        }

        int outputIndex = codec.dequeueOutputBuffer(bufferInfo, 0L);
        if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          // ignore
        } else if (outputIndex >= 0) {
          codec.releaseOutputBuffer(outputIndex, true);
        }

        if (System.currentTimeMillis() > keepaliveAt) {
          keepaliveAt = System.currentTimeMillis() + KEEPALIVE_INTERVAL_MS;
          sendKeepalive(out, baseUrl, session);
        }
      }
    } catch (IOException e) {
      throw e;
    } catch (Exception e) {
      throw new IOException(e);
    } finally {
      if (codec != null) {
        try {
          codec.stop();
          codec.release();
        } catch (Exception ignored) {
        }
      }
      if (reader != null) {
        try {
          reader.close();
        } catch (Exception ignored) {
        }
      }
      if (imageThread != null) imageThread.quitSafely();
    }
  }

  private void sendKeepalive(OutputStream out, String baseUrl, String session) {
    try {
      String request = "OPTIONS " + baseUrl + " RTSP/1.0\r\n"
        + "CSeq: 9999\r\n"
        + (session == null ? "" : "Session: " + session + "\r\n")
        + "\r\n";
      synchronized (out) {
        out.write(request.getBytes(StandardCharsets.US_ASCII));
        out.flush();
      }
    } catch (IOException e) {
      Log.w(TAG, "[" + serial + "] keepalive failed", e);
    }
  }

  private void onFrameAvailable(ImageReader imageReader) {
    if (System.currentTimeMillis() - lastFrameAt < MIN_FRAME_INTERVAL_MS) {
      Image skipped = null;
      try {
        skipped = imageReader.acquireLatestImage();
      } catch (Exception ignored) {
      } finally {
        if (skipped != null) skipped.close();
      }
      return;
    }
    Image image = null;
    try {
      image = imageReader.acquireLatestImage();
      if (image == null) return;
      byte[] jpeg = toJpeg(image);
      if (jpeg != null && jpeg.length > 0) {
        latestJpeg.set(jpeg);
        lastFrameAt = System.currentTimeMillis();
        if (!"streaming".equals(status)) status = "streaming";
      }
    } catch (Exception e) {
      Log.w(TAG, "[" + serial + "] frame conversion failed", e);
    } finally {
      if (image != null) image.close();
    }
  }

  private static byte[] toJpeg(Image image) {
    int width = image.getWidth();
    int height = image.getHeight();
    Image.Plane[] planes = image.getPlanes();
    if (planes.length < 3) return null;

    Image.Plane yPlane = planes[0];
    Image.Plane uPlane = planes[1];
    Image.Plane vPlane = planes[2];

    byte[] nv21 = new byte[width * height * 3 / 2];
    ByteBuffer yBuf = yPlane.getBuffer();
    ByteBuffer uBuf = uPlane.getBuffer();
    ByteBuffer vBuf = vPlane.getBuffer();

    int yRowStride = yPlane.getRowStride();
    int yPixelStride = yPlane.getPixelStride();
    int uRowStride = uPlane.getRowStride();
    int uPixelStride = uPlane.getPixelStride();
    int vRowStride = vPlane.getRowStride();
    int vPixelStride = vPlane.getPixelStride();

    int pos = 0;
    yBuf.rewind();
    for (int row = 0; row < height; row++) {
      int start = row * yRowStride;
      if (start + width > yBuf.capacity()) break;
      if (yPixelStride == 1) {
        yBuf.position(start);
        yBuf.get(nv21, pos, width);
        pos += width;
      } else {
        for (int col = 0; col < width; col++) {
          nv21[pos++] = yBuf.get(start + col * yPixelStride);
        }
      }
    }

    uBuf.rewind();
    vBuf.rewind();
    int chromaHeight = height / 2;
    int chromaWidth = width / 2;
    for (int row = 0; row < chromaHeight; row++) {
      int vStart = row * vRowStride;
      int uStart = row * uRowStride;
      for (int col = 0; col < chromaWidth; col++) {
        int vIndex = vStart + col * vPixelStride;
        int uIndex = uStart + col * uPixelStride;
        if (vIndex >= vBuf.capacity() || uIndex >= uBuf.capacity()) break;
        nv21[pos++] = vBuf.get(vIndex); // NV21 stores V before U
        nv21[pos++] = uBuf.get(uIndex);
      }
    }

    try {
      YuvImage yuvImage = new YuvImage(nv21, ImageFormat.NV21, width, height, null);
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      boolean ok = yuvImage.compressToJpeg(new Rect(0, 0, width, height), JPEG_QUALITY, out);
      return ok ? out.toByteArray() : null;
    } catch (Exception e) {
      Log.w(TAG, "jpeg encode failed", e);
      return null;
    }
  }

  // ------------------------------------------------------------ RTP / H.264

  private static final class FuReassembler {
    boolean active;
    byte[] buffer = new byte[0];
    int length;

    void reset() {
      active = false;
      length = 0;
    }

    void start(byte header, byte indicator) {
      buffer = new byte[65536];
      length = 0;
      buffer[length++] = (byte) ((indicator & 0xE0) | (header & 0x1F));
      active = true;
    }

    void append(byte[] data, int offset, int count) {
      if (length + count > buffer.length) {
        byte[] grown = new byte[Math.max(buffer.length * 2, length + count)];
        System.arraycopy(buffer, 0, grown, 0, length);
        buffer = grown;
      }
      System.arraycopy(data, offset, buffer, length, count);
      length += count;
    }

    byte[] finish() {
      byte[] result = new byte[length];
      System.arraycopy(buffer, 0, result, 0, length);
      active = false;
      return result;
    }
  }

  /** Returns a complete NAL unit (without start code) or null when more data is needed. */
  private static byte[] extractNal(byte[] rtp, FuReassembler fu) {
    if (rtp.length < 13) return null;
    int version = (rtp[0] >> 6) & 0x03;
    if (version != 2) return null;
    int padding = (rtp[0] & 0x20) != 0 ? 1 : 0;
    int csrcCount = rtp[0] & 0x0F;
    int extension = (rtp[0] & 0x10) != 0 ? 1 : 0;
    int headerLength = 12 + csrcCount * 4;
    int payloadStart = headerLength;
    if (extension == 1) {
      if (rtp.length < headerLength + 4) return null;
      int extLength = ((rtp[headerLength + 2] & 0xFF) << 8) | (rtp[headerLength + 3] & 0xFF);
      payloadStart = headerLength + 4 + extLength * 4;
    }
    int payloadLength = rtp.length - payloadStart - padding * 4;
    if (payloadLength <= 0 || payloadStart + payloadLength > rtp.length) return null;

    byte nalHeader = rtp[payloadStart];
    int type = nalHeader & 0x1F;
    if (type >= 1 && type <= 23) {
      fu.reset();
      byte[] nal = new byte[payloadLength];
      System.arraycopy(rtp, payloadStart, nal, 0, payloadLength);
      return nal;
    }
    if (type == 28) { // FU-A
      byte fuHeader = rtp[payloadStart + 1];
      boolean start = (fuHeader & 0x80) != 0;
      boolean end = (fuHeader & 0x40) != 0;
      if (start) fu.start(fuHeader, nalHeader);
      if (!fu.active) return null;
      fu.append(rtp, payloadStart + 2, payloadLength - 2);
      return end ? fu.finish() : null;
    }
    if (type == 24) { // STAP-A: return the first contained NAL
      fu.reset();
      int offset = payloadStart + 1;
      while (offset + 2 <= payloadStart + payloadLength) {
        int nalSize = ((rtp[offset] & 0xFF) << 8) | (rtp[offset + 1] & 0xFF);
        offset += 2;
        if (nalSize <= 0 || offset + nalSize > payloadStart + payloadLength) break;
        byte[] nal = new byte[nalSize];
        System.arraycopy(rtp, offset, nal, 0, nalSize);
        return nal;
      }
      return null;
    }
    fu.reset();
    return null;
  }

  private static byte[] withParameterSets(TrackInfo track, byte[] nal, boolean idr) {
    byte[] sps = track.sps;
    byte[] pps = track.pps;
    if (!idr || sps == null || pps == null) return nal;
    byte[] result = new byte[4 + sps.length + 4 + pps.length + 4 + nal.length];
    int pos = 0;
    result[pos++] = 0; result[pos++] = 0; result[pos++] = 0; result[pos++] = 1;
    System.arraycopy(sps, 0, result, pos, sps.length);
    pos += sps.length;
    result[pos++] = 0; result[pos++] = 0; result[pos++] = 0; result[pos++] = 1;
    System.arraycopy(pps, 0, result, pos, pps.length);
    pos += pps.length;
    result[pos++] = 0; result[pos++] = 0; result[pos++] = 0; result[pos++] = 1;
    System.arraycopy(nal, 0, result, pos, nal.length);
    return result;
  }

  private static byte[] readFully(InputStream in, int length) throws IOException {
    byte[] data = new byte[length];
    int read = 0;
    while (read < length) {
      int n = in.read(data, read, length - read);
      if (n < 0) throw new EOFException("stream closed");
      read += n;
    }
    return data;
  }

  // ------------------------------------------------------------------- SDP

  private static TrackInfo parseSdp(String sdp, String baseUrl) {
    TrackInfo track = new TrackInfo(baseUrl);
    if (sdp == null) return track;
    String[] lines = sdp.split("\r\n|\n");
    boolean inVideo = false;
    for (String raw : lines) {
      String line = raw.trim();
      if (line.startsWith("m=video")) {
        inVideo = true;
        continue;
      }
      if (line.startsWith("m=")) {
        inVideo = false;
        continue;
      }
      if (!inVideo) continue;
      if (line.startsWith("a=control:")) {
        String control = line.substring("a=control:".length()).trim();
        if ("*".equals(control) || control.isEmpty()) {
          track.controlUrl = baseUrl;
        } else if (control.startsWith("rtsp://")) {
          track.controlUrl = control;
        } else {
          track.controlUrl = baseUrl + (control.startsWith("/") ? "" : "/") + control;
        }
      } else if (line.startsWith("a=fmtp:")) {
        String fmtp = line.substring("a=fmtp:".length());
        int spsIndex = fmtp.indexOf("sprop-parameter-sets=");
        if (spsIndex >= 0) {
          String value = fmtp.substring(spsIndex + "sprop-parameter-sets=".length());
          int end = value.indexOf(';');
          if (end > 0) value = value.substring(0, end);
          String[] parts = value.split(",");
          if (parts.length > 0) track.sps = decodeBase64(parts[0]);
          if (parts.length > 1) track.pps = decodeBase64(parts[1]);
        }
      } else if (line.startsWith("a=framesize:")) {
        // a=framesize:96 1920-1080
        String[] tokens = line.substring("a=framesize:".length()).trim().split(" ");
        if (tokens.length > 1) {
          String[] size = tokens[1].split("-");
          if (size.length == 2) {
            track.width = parseInt(size[0]);
            track.height = parseInt(size[1]);
          }
        }
      } else if (line.startsWith("a=cliprect:") && track.width <= 0) {
        String[] parts = line.substring("a=cliprect:".length()).trim().split(",");
        if (parts.length >= 4) {
          track.width = parseInt(parts[2]) - parseInt(parts[0]);
          track.height = parseInt(parts[3]) - parseInt(parts[1]);
        }
      } else if (line.startsWith("a=x-dimensions:")) {
        String[] dims = line.substring("a=x-dimensions:".length()).trim().split(",");
        if (dims.length >= 2) {
          track.width = parseInt(dims[0]);
          track.height = parseInt(dims[1]);
        }
      }
    }
    if (track.width <= 0 || track.height <= 0) {
      // Fall back to a common P1/P1S camera resolution; MediaCodec reconfigures
      // itself from the SPS anyway.
      track.width = 1280;
      track.height = 720;
    }
    return track;
  }

  private static byte[] decodeBase64(String value) {
    try {
      return Base64.decode(value.trim(), Base64.DEFAULT);
    } catch (Exception e) {
      return null;
    }
  }

  private static int parseInt(String value) {
    try {
      return Integer.parseInt(value.trim());
    } catch (Exception e) {
      return 0;
    }
  }

  private static int[] parseInterleaved(String transport) {
    int[] channels = new int[]{0, 1};
    if (transport == null) return channels;
    int index = transport.indexOf("interleaved=");
    if (index < 0) return channels;
    String value = transport.substring(index + "interleaved=".length());
    int end = value.indexOf(';');
    if (end > 0) value = value.substring(0, end);
    String[] parts = value.split("-");
    if (parts.length >= 1) channels[0] = parseInt(parts[0]);
    if (parts.length >= 2) channels[1] = parseInt(parts[1]);
    return channels;
  }

  // ------------------------------------------------------------------ RTSP

  private static final class AuthState {
    String realm;
    String nonce;
    String opaque;
  }

  private static final class CseqCounter {
    int value;
  }

  private static final class TrackInfo {
    String controlUrl;
    int width;
    int height;
    byte[] sps;
    byte[] pps;

    TrackInfo(String baseUrl) {
      controlUrl = baseUrl;
    }
  }

  private static final class RtspResponse {
    int code;
    Map<String, String> headers = new HashMap<>();
    String body = "";
  }

  private RtspResponse request(OutputStream out, InputStream in, String method, String url,
                               String extraHeaders, AuthState auth, String session,
                               CseqCounter cseq) throws IOException {
    RtspResponse response = send(out, in, method, url, extraHeaders, auth, session, cseq);
    if (response.code == 401 && auth != null) {
      parseChallenge(response.headers.get("www-authenticate"), auth);
      response = send(out, in, method, url, extraHeaders, auth, session, cseq);
    }
    return response;
  }

  private RtspResponse send(OutputStream out, InputStream in, String method, String url,
                            String extraHeaders, AuthState auth, String session,
                            CseqCounter cseq) throws IOException {
    int seq = ++cseq.value;
    StringBuilder builder = new StringBuilder();
    builder.append(method).append(' ').append(url).append(" RTSP/1.0\r\n");
    builder.append("CSeq: ").append(seq).append("\r\n");
    builder.append("User-Agent: P1Screen\r\n");
    if (session != null) builder.append("Session: ").append(session).append("\r\n");
    if (auth != null && auth.realm != null && auth.nonce != null) {
      String password = accessCode == null ? "" : accessCode;
      String ha1 = md5(RTSP_USER + ":" + auth.realm + ":" + password);
      String ha2 = md5(method + ":" + url);
      String digest = md5(ha1 + ":" + auth.nonce + ":" + ha2);
      builder.append("Authorization: Digest username=\"").append(RTSP_USER).append('"')
        .append(", realm=\"").append(auth.realm).append('"')
        .append(", nonce=\"").append(auth.nonce).append('"')
        .append(", uri=\"").append(url).append('"')
        .append(", response=\"").append(digest).append('"');
      if (auth.opaque != null) builder.append(", opaque=\"").append(auth.opaque).append('"');
      builder.append("\r\n");
    }
    if (extraHeaders != null) builder.append(extraHeaders);
    builder.append("\r\n");

    synchronized (out) {
      out.write(builder.toString().getBytes(StandardCharsets.US_ASCII));
      out.flush();
    }
    return readResponse(in);
  }

  private static RtspResponse readResponse(InputStream in) throws IOException {
    RtspResponse response = new RtspResponse();
    StringBuilder line = new StringBuilder();
    int c;
    // status line
    while ((c = in.read()) >= 0 && c != '\n') {
      if (c != '\r') line.append((char) c);
    }
    String statusLine = line.toString().trim();
    String[] parts = statusLine.split(" ");
    if (parts.length >= 2) {
      response.code = parseInt(parts[1]);
    }
    // headers
    while (true) {
      line.setLength(0);
      while ((c = in.read()) >= 0 && c != '\n') {
        if (c != '\r') line.append((char) c);
      }
      if (c < 0) break;
      String header = line.toString().trim();
      if (header.isEmpty()) break;
      int colon = header.indexOf(':');
      if (colon > 0) {
        response.headers.put(header.substring(0, colon).trim().toLowerCase(Locale.US),
          header.substring(colon + 1).trim());
      }
    }
    int contentLength = parseInt(response.headers.get("content-length"));
    if (contentLength > 0) {
      byte[] body = readFully(in, contentLength);
      response.body = new String(body, StandardCharsets.UTF_8);
    }
    return response;
  }

  private static void parseChallenge(String header, AuthState auth) {
    if (header == null) return;
    String lower = header.toLowerCase(Locale.US);
    if (!lower.startsWith("digest")) return;
    auth.realm = extractQuoted(header, "realm");
    auth.nonce = extractQuoted(header, "nonce");
    auth.opaque = extractQuoted(header, "opaque");
  }

  private static String extractQuoted(String header, String key) {
    int index = header.indexOf(key + "=");
    if (index < 0) return null;
    int start = header.indexOf('"', index);
    if (start < 0) {
      String tail = header.substring(index + key.length() + 1);
      int end = tail.indexOf(',');
      return end > 0 ? tail.substring(0, end).trim() : tail.trim();
    }
    int end = header.indexOf('"', start + 1);
    if (end < 0) return null;
    return header.substring(start + 1, end);
  }

  private static String md5(String value) {
    try {
      MessageDigest digest = MessageDigest.getInstance("MD5");
      byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder builder = new StringBuilder();
      for (byte b : bytes) {
        builder.append(String.format(Locale.US, "%02x", b));
      }
      return builder.toString();
    } catch (Exception e) {
      return "";
    }
  }

  // ------------------------------------------------------------------- TLS

  private SSLSocketFactory createTrustAllSocketFactory() throws Exception {
    TrustManager[] trustAll = new TrustManager[]{
      new X509TrustManager() {
        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
          return new X509Certificate[0];
        }
      }
    };
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, trustAll, new java.security.SecureRandom());
    return context.getSocketFactory();
  }
}
