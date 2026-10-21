package com.bambulab.p1screen;

import android.util.Log;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Keeps one {@link CameraStream} per printer serial and exposes the latest
 * decoded frame so the local HTTP server can serve it to the web UI.
 */
public final class CameraStreamManager {
  private static final String TAG = "CameraStreamManager";
  private static final CameraStreamManager INSTANCE = new CameraStreamManager();

  private final Map<String, CameraStream> streams = new ConcurrentHashMap<>();

  private CameraStreamManager() {
  }

  public static CameraStreamManager getInstance() {
    return INSTANCE;
  }

  public void start(String serial, String ip, String code) {
    if (serial == null || serial.isEmpty() || ip == null || ip.isEmpty()
      || code == null || code.isEmpty()) {
      Log.w(TAG, "start called with incomplete parameters");
      return;
    }
    CameraStream existing = streams.get(serial);
    if (existing != null && existing.isRunning()) {
      existing.stop();
    }
    CameraStream stream = new CameraStream(serial, ip, code);
    streams.put(serial, stream);
    stream.start();
    Log.i(TAG, "started camera stream for " + serial);
  }

  public void stop(String serial) {
    if (serial == null) return;
    CameraStream stream = streams.remove(serial);
    if (stream != null) {
      stream.stop();
      Log.i(TAG, "stopped camera stream for " + serial);
    }
  }

  public void stopAll() {
    for (String serial : streams.keySet()) {
      stop(serial);
    }
  }

  /** Latest JPEG frame, or null when nothing has been decoded yet. */
  public byte[] getFrame(String serial) {
    CameraStream stream = streams.get(serial);
    return stream == null ? null : stream.getLatestJpeg();
  }

  /**
   * One of: idle, connecting, streaming, reconnecting, error:&lt;reason&gt;.
   * Returns "not_started" when no stream is registered for the serial.
   */
  public String getStatus(String serial) {
    CameraStream stream = streams.get(serial);
    return stream == null ? "not_started" : stream.getStatus();
  }
}
