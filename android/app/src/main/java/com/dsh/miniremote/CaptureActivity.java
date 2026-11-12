package com.dsh.miniremote;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.DisplayMetrics;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;

/**
 * 应用内相机（2026-11-06）。
 *
 * 为什么自己做：荣耀把「第三方应用调用系统相机」封了，ACTION_IMAGE_CAPTURE 抛
 * Permission Denial。
 *
 * 为什么不用相机直出的 JPEG：这台机器的相机固件会给出坏图（预览正常、照片是花屏
 * 条纹，CameraX 里专门有一个 JpegHalCorruptImage 的绕行）。所以这里只要原始帧
 * （YUV_420_888），JPEG 由我们自己编码——多条实测中这是唯一稳定的路。
 */
public class CaptureActivity extends Activity {
    private static final int REQUEST_CAMERA = 7;

    private SurfaceView preview;
    private CameraManager manager;
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader reader;
    private String cameraId;
    private HandlerThread thread;
    private Handler handler;
    private int sensorOrientation = 90;
    private boolean taking;
    private boolean surfaceReady;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        thread = new HandlerThread("capture");
        thread.start();
        handler = new Handler(thread.getLooper());

        // 取景尺寸必须在建 Surface 之前定好：建好之后再改尺寸会把画面拆掉重建，
        // 会话就起不来了（2026-11-06 真机踩过）。
        Size shown = resolvePreviewSize();
        buildUi(shown);
        preview.getHolder().setFixedSize(shown.getWidth(), shown.getHeight());

        preview.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override
            public void surfaceCreated(SurfaceHolder holder) {
                surfaceReady = true;
                openCamera();
            }

            @Override
            public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
                startSession();
            }

            @Override
            public void surfaceDestroyed(SurfaceHolder holder) {
                surfaceReady = false;
            }
        });

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.CAMERA }, REQUEST_CAMERA);
        }
    }

    private void buildUi(Size shown) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        preview = new SurfaceView(this);
        // 取景框按相机画面的比例摆，不能按屏幕比例硬拉——否则画面会被压扁/拉长。
        DisplayMetrics dm = getResources().getDisplayMetrics();
        float aspect = (float) shown.getWidth() / shown.getHeight();
        int preWidth = dm.heightPixels;
        int preHeight = Math.round(preWidth / aspect);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(preWidth, preHeight);
        lp.gravity = Gravity.CENTER;
        preview.setLayoutParams(lp);
        preview.setRotation(270);
        root.addView(preview);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(24, 24, 24, 48);

        Button cancel = new Button(this);
        cancel.setText("取消");
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setResult(RESULT_CANCELED);
                finish();
            }
        });
        bar.addView(cancel, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button shutter = new Button(this);
        shutter.setText("拍一张");
        shutter.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shoot();
            }
        });
        bar.addView(shutter, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 2f));

        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barParams.gravity = Gravity.BOTTOM;
        root.addView(bar, barParams);
        setContentView(root);
        // 左边缘滑动返回（2026-11-12）：这一页能退回会话主页面。
        SwipeBack.install(this);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQUEST_CAMERA) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                openCamera();
            } else {
                Toast.makeText(this, "没有相机权限，拍不了照。", Toast.LENGTH_LONG).show();
                finish();
            }
        }
    }

    private void openCamera() {
        if (device != null || !surfaceReady
                || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics info = manager.getCameraCharacteristics(id);
                Integer facing = info.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    cameraId = id;
                    Integer orientation = info.get(CameraCharacteristics.SENSOR_ORIENTATION);
                    if (orientation != null) {
                        sensorOrientation = orientation;
                    }
                    break;
                }
            }
            if (cameraId == null) {
                throw new IllegalStateException("这台手机没有后置相机");
            }
            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    device = camera;
                    startSession();
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    camera.close();
                    device = null;
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    Toast.makeText(CaptureActivity.this, "相机出错（" + error + "）", Toast.LENGTH_LONG).show();
                    camera.close();
                    device = null;
                    finish();
                }
            }, handler);
        } catch (Exception err) {
            Toast.makeText(this, "相机打不开：" + err.getMessage(), Toast.LENGTH_LONG).show();
            finish();
        }
    }

    private void startSession() {
        if (device == null || !surfaceReady || session != null) {
            return;
        }
        try {
            Size frame = pickFrameSize();
            reader = ImageReader.newInstance(frame.getWidth(), frame.getHeight(),
                    ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader source) {
                    Image image = source.acquireNextImage();
                    if (image == null) {
                        return;
                    }
                    try {
                        Bitmap bitmap = toBitmap(image);
                        save(bitmap);
                    } catch (Exception err) {
                        taking = false;
                        Toast.makeText(CaptureActivity.this,
                                "保存照片失败：" + err.getMessage(), Toast.LENGTH_LONG).show();
                    } finally {
                        image.close();
                    }
                }
            }, handler);

            Surface target = preview.getHolder().getSurface();
            final CaptureRequest.Builder builder =
                    device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(target);
            device.createCaptureSession(
                    Arrays.asList(target, reader.getSurface()),
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession ready) {
                            session = ready;
                            try {
                                ready.setRepeatingRequest(builder.build(), null, handler);
                            } catch (Exception err) {
                                Toast.makeText(CaptureActivity.this,
                                        "预览失败：" + err.getMessage(), Toast.LENGTH_LONG).show();
                            }
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession failed) {
                            Toast.makeText(CaptureActivity.this, "相机配置失败", Toast.LENGTH_LONG).show();
                        }
                    }, handler);
        } catch (Exception err) {
            Toast.makeText(this, "相机打不开：" + err.getMessage(), Toast.LENGTH_LONG).show();
            finish();
        }
    }

    /** 找到后置相机，并挑一个适合取景的尺寸；拿不到就退回 1280×960。 */
    private Size resolvePreviewSize() {
        try {
            if (cameraId == null) {
                for (String id : manager.getCameraIdList()) {
                    CameraCharacteristics info = manager.getCameraCharacteristics(id);
                    Integer facing = info.get(CameraCharacteristics.LENS_FACING);
                    if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                        cameraId = id;
                        Integer orientation = info.get(CameraCharacteristics.SENSOR_ORIENTATION);
                        if (orientation != null) {
                            sensorOrientation = orientation;
                        }
                        break;
                    }
                }
            }
            if (cameraId != null) {
                return pickPreviewSize();
            }
        } catch (Exception ignored) {
            // 拿不到相机信息就退回默认尺寸，界面照常搭起来。
        }
        return new Size(1280, 960);
    }

    /** 取景用的尺寸：接近 4:3、面积适中，预览才不容易变形。 */
    private Size pickPreviewSize() throws Exception {
        CameraCharacteristics info = manager.getCameraCharacteristics(cameraId);
        android.hardware.camera2.params.StreamConfigurationMap map =
                info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
        Size best = sizes[0];
        double bestScore = Double.MAX_VALUE;
        for (Size size : sizes) {
            long area = (long) size.getWidth() * size.getHeight();
            if (area < 640L * 480L || area > 2000L * 1000L) {
                continue;
            }
            double aspect = (double) size.getWidth() / size.getHeight();
            double score = Math.abs(aspect - 4.0 / 3.0);
            if (score < bestScore) {
                bestScore = score;
                best = size;
            }
        }
        return best;
    }

    /** 取景框尺寸：在相机支持的原始帧尺寸里挑一个不超过 190 万像素的。 */
    private Size pickFrameSize() throws Exception {
        CameraCharacteristics info = manager.getCameraCharacteristics(cameraId);
        android.hardware.camera2.params.StreamConfigurationMap map =
                info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
        Size best = sizes[0];
        long bestArea = 0;
        for (Size size : sizes) {
            long area = (long) size.getWidth() * size.getHeight();
            if (area > bestArea && area <= 2000L * 1000L) {
                bestArea = area;
                best = size;
            }
        }
        return best;
    }

    private void shoot() {
        if (device == null || session == null || taking) {
            Toast.makeText(this, "相机还在准备，稍等一下", Toast.LENGTH_SHORT).show();
            return;
        }
        taking = true;
        try {
            CaptureRequest.Builder still = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            still.addTarget(reader.getSurface());
            still.set(CaptureRequest.CONTROL_AF_MODE,
                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            session.capture(still.build(), null, handler);
        } catch (Exception err) {
            taking = false;
            Toast.makeText(this, "拍照失败：" + err.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** 原始帧 → 位图：自己算 YUV→RGB，不依赖系统的 NV21 编码器（它的输出在这台机器上是噪点）。 */
    private static Bitmap toBitmap(Image image) {
        int width = image.getWidth();
        int height = image.getHeight();
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer yBuffer = planes[0].getBuffer();
        ByteBuffer uBuffer = planes[1].getBuffer();
        ByteBuffer vBuffer = planes[2].getBuffer();
        int yRowStride = planes[0].getRowStride();
        int yPixelStride = planes[0].getPixelStride();
        int uRowStride = planes[1].getRowStride();
        int uPixelStride = planes[1].getPixelStride();
        int vRowStride = planes[2].getRowStride();
        int vPixelStride = planes[2].getPixelStride();

        int[] argb = new int[width * height];
        for (int row = 0; row < height; row += 1) {
            int chromaRow = (row / 2) * uRowStride;
            int chromaRowV = (row / 2) * vRowStride;
            for (int col = 0; col < width; col += 1) {
                int y = yBuffer.get(row * yRowStride + col * yPixelStride) & 0xFF;
                int u = uBuffer.get(chromaRow + (col / 2) * uPixelStride) & 0xFF;
                int v = vBuffer.get(chromaRowV + (col / 2) * vPixelStride) & 0xFF;
                int r = clamp(y + (int) (1.402 * (v - 128)));
                int g = clamp(y - (int) (0.344136 * (u - 128)) - (int) (0.714136 * (v - 128)));
                int b = clamp(y + (int) (1.772 * (u - 128)));
                argb[row * width + col] = (0xFF << 24) | (r << 16) | (g << 8) | b;
            }
        }
        return Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888);
    }

    private static int clamp(int value) {
        if (value < 0) {
            return 0;
        }
        if (value > 255) {
            return 255;
        }
        return value;
    }

    /** 写文件：按相机传感器的安装角度转正竖拍画面，再把文件地址交回网页。 */
    private void save(Bitmap bitmap) {
        try {
            File dir = new File(getCacheDir(), "camera");
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IllegalStateException("缓存目录建不出来");
            }
            File file = File.createTempFile("shot-", ".jpg", dir);
            Matrix matrix = new Matrix();
            matrix.postRotate(sensorOrientation);
            Bitmap upright = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(),
                    bitmap.getHeight(), matrix, true);
            FileOutputStream out = new FileOutputStream(file);
            try {
                upright.compress(Bitmap.CompressFormat.JPEG, 90, out);
            } finally {
                out.close();
            }
            bitmap.recycle();
            upright.recycle();
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
            setResult(RESULT_OK, new Intent().setData(uri));
            finish();
        } catch (Exception err) {
            Toast.makeText(this, "保存照片失败：" + err.getMessage(), Toast.LENGTH_LONG).show();
        } finally {
            taking = false;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        closeCamera();
    }

    private void closeCamera() {
        try {
            if (session != null) {
                session.close();
                session = null;
            }
            if (device != null) {
                device.close();
                device = null;
            }
            if (reader != null) {
                reader.close();
                reader = null;
            }
        } catch (Exception ignored) {
            // 关的时候出错没什么可做的。
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        closeCamera();
        if (thread != null) {
            thread.quitSafely();
        }
    }
}
