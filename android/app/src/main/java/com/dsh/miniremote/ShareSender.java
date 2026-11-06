package com.dsh.miniremote;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 系统分享：从别的应用把文字或图片发给 DSH（2026-11-06）。
 *
 * 走的是网页端同一组接口：先 POST /mini/api/upload 换一张「小票」，
 * 再 POST /mini/api/send 把小票和文字一起交上去。没有另一套协议。
 */
final class ShareSender {
    private static final int MAX_BYTES = 20 * 1024 * 1024;

    static final class Payload {
        final String text;
        final List<Uri> streams;

        Payload(String text, List<Uri> streams) {
            this.text = text;
            this.streams = streams;
        }

        boolean isEmpty() {
            return (text == null || text.trim().isEmpty()) && streams.isEmpty();
        }

        boolean hasStreams() {
            return !streams.isEmpty();
        }
    }

    private ShareSender() {
    }

    /** 从 ACTION_SEND / ACTION_SEND_MULTIPLE 里取出文字和文件；不认识的类型返回空。 */
    static Payload parse(Intent intent) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return null;
        }
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        List<Uri> streams = new ArrayList<Uri>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) {
                streams.add(one);
            }
        } else {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) {
                for (Uri uri : many) {
                    if (uri != null) {
                        streams.add(uri);
                    }
                }
            }
        }
        Payload payload = new Payload(text, streams);
        return payload.isEmpty() ? null : payload;
    }

    /** 必须在后台线程调用；返回给用户看的一句话。 */
    static String submit(Context context, String baseUrl, String credential, Payload payload)
            throws Exception {
        ContentResolver resolver = context.getContentResolver();
        JSONArray uploadIds = new JSONArray();
        for (int i = 0; i < payload.streams.size(); i += 1) {
            Uri uri = payload.streams.get(i);
            String name = displayName(resolver, uri, "share-" + (i + 1));
            byte[] bytes = readAll(resolver, uri);
            String url = baseUrl + "/mini/api/upload?name=" + Uri.encode(name)
                    + "&size=" + bytes.length;
            Net.Response uploaded = Net.postBytes(url, bytes, credential);
            if (!uploaded.isSuccess()) {
                throw new Exception(uploaded.chineseError());
            }
            JSONObject json = new JSONObject(uploaded.body);
            String id = json.optString("uploadId", "");
            if (id.isEmpty()) {
                throw new Exception("电脑没有返回文件编号。");
            }
            uploadIds.put(id);
        }

        JSONObject body = new JSONObject();
        body.put("text", payload.text == null ? "" : payload.text);
        body.put("uploadIds", uploadIds);
        Net.Response sent = Net.postJson(baseUrl + "/mini/api/send", body.toString(), credential);
        if (!sent.isSuccess()) {
            throw new Exception(sent.chineseError());
        }
        return payload.hasStreams() ? "已发给 DSH" : "已发送";
    }

    private static String displayName(ContentResolver resolver, Uri uri, String fallback) {
        Cursor cursor = null;
        try {
            cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) {
                    return name;
                }
            }
        } catch (Exception ignored) {
            // 取不到名字就用兜底名，不影响上传。
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return fallback;
    }

    private static byte[] readAll(ContentResolver resolver, Uri uri) throws Exception {
        InputStream input = resolver.openInputStream(uri);
        if (input == null) {
            throw new Exception("读不到这个文件。");
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                out.write(buffer, 0, count);
                if (out.size() > MAX_BYTES) {
                    throw new Exception("文件太大，手机上最多发 20 MB。");
                }
            }
            return out.toByteArray();
        } finally {
            input.close();
        }
    }

    static void toast(final android.app.Activity activity, final String message) {
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
            }
        });
    }
}
