package com.elainachat.mod;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "ByokSecrets")
public class ByokSecretsPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "elainachat_open_byok_v1";
    private static final String PREFS_NAME = "elainachat_open_encrypted_secrets";

    /**
     * 允许存进密钥库的键名白名单。
     *
     * <p>与前端 {@code web/js/core.js} 的 {@code API_SECRET_NAMES} 一一对应 ——
     * 两边一旦脱节就是这个后果：{@link #setSecret} 直接
     * {@code reject("Unsupported secret name")}，{@link #getSecret} 同理，
     * 于是前端 {@code loadApiSecrets()} 读不到值、把内存里的 Key 覆盖成空串：
     * <b>用户在设置里填好的 Key，退出应用再进来就没了</b>（实测只影响
     * asrApiKey / mimoApiKey / mimoTtsApiKey / openaiTtsApiKey 这四个）。
     *
     * <p>⚠️ 加前端密钥名时必须同步加到这里，两边必须一一对应。
     * 前端那份在 {@code web/js/core.js} 的 {@code API_SECRET_NAMES}。
     */
    private static final Set<String> ALLOWED_NAMES = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(
            "apiKey", "minimaxApiKey", "dashscopeApiKey",
            "asrApiKey", "mimoApiKey", "mimoTtsApiKey", "openaiTtsApiKey",
            // 联网搜索的凭据（按服务商分开存）。与前端 API_SECRET_NAMES 一一对应 ——
            //   漏了任一项，手机上填好的那家 Key 退出应用就没了（见上面那段说明）。
            "searchApiKey_tavily", "searchApiKey_custom",
            // 多提供商对话模型的 Key 集合（JSON 串：{ providerId: apiKey }），与前端 API_SECRET_NAMES 对应
            "chatProviderKeys",
            // 前端已不再使用，留着只为兼容老数据里的值
            "doubaoApiKey", "doubaoToken"
        ))
    );

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private String decrypt(String stored) throws Exception {
        String[] parts = stored.split(":", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted secret");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    private String requireAllowedName(PluginCall call) {
        String name = call.getString("name", "");
        if (!ALLOWED_NAMES.contains(name)) {
            call.reject("Unsupported secret name");
            return null;
        }
        return name;
    }

    /** 解密失败时密文搬到这里留底：Keystore 密钥失效（系统升级、恢复出厂、从其它设备备份恢复）
        是用户无法自救的故障，把密文删掉等于连「以后有办法解开」的可能一起丢掉。 */
    private static final String QUARANTINE_SUFFIX = "__undecryptable";

    @PluginMethod
    public void getSecret(PluginCall call) {
        String name = requireAllowedName(call);
        if (name == null) return;
        String stored = preferences().getString(name, "");
        String value = "";
        if (!stored.isEmpty()) {
            try {
                value = decrypt(stored);
            } catch (Exception error) {
                // 读不到 ≠ 用户清空：必须以错误码回给前端，让它按「这项读不到」处理并跳过写回。
                // 返回空值会被当成"用户删了这个 Key"，随后任何一次保存都把空值写回密钥库，
                // 用户看到的就是"更新完 Key 没了"且没有任何提示。
                quarantine(name, stored);
                call.reject("密钥无法解密（Keystore 密钥已失效），请重新填写", "SECRET_UNREADABLE");
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("value", value);
        call.resolve(result);
    }

    /** 把解不开的密文挪到隔离键：同名条目只留一份，重复进入不叠加。 */
    private void quarantine(String name, String stored) {
        try {
            SharedPreferences.Editor editor = preferences().edit();
            editor.putString(name + QUARANTINE_SUFFIX, stored);
            editor.remove(name);
            editor.apply();
            Log.w("ByokSecrets", "密钥 " + name + " 无法解密，密文已隔离保留（重新填写后会覆盖）");
        } catch (Exception error) {
            Log.w("ByokSecrets", "隔离无法解密的密钥失败：" + error.getMessage());
        }
    }

    @PluginMethod
    public void setSecret(PluginCall call) {
        String name = requireAllowedName(call);
        if (name == null) return;
        String value = call.getString("value", "").trim();
        try {
            SharedPreferences.Editor editor = preferences().edit();
            if (value.isEmpty()) editor.remove(name);
            else editor.putString(name, encrypt(value));
            // 用户重填即视为放弃旧密文：留着隔离副本只会在下次排查时被当成"还有一份 Key"。
            editor.remove(name + QUARANTINE_SUFFIX);
            editor.apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to store secret securely", error);
        }
    }

    @PluginMethod
    public void clearSecrets(PluginCall call) {
        SharedPreferences.Editor editor = preferences().edit();
        for (String name : ALLOWED_NAMES) {
            editor.remove(name);
            editor.remove(name + QUARANTINE_SUFFIX);
        }
        editor.apply();
        call.resolve();
    }
}
