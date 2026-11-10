package com.dsh.miniremote;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 发给模型的文字打码；不读屏幕、不依赖安卓，也不决定是否允许操作。
 *
 * 规则宁可有明确边界：卡号要过 Luhn，验证码要有上下文。否则订单号、金额和
 * 计算器上的普通数字会被误伤，模型反而无法完成正常任务。
 */
final class SensitiveText {
    private static final Pattern CODE = Pattern.compile(
            "(?:验证码|校验码|动态码)\\s*(?:是|为)?\\s*[:：]?\\s*(\\d{4,8})(?!\\d)");
    private static final Pattern ID = Pattern.compile("(?<!\\d)\\d{17}[\\dXx](?!\\d)");
    private static final Pattern PHONE = Pattern.compile("(?<!\\d)1[3-9]\\d{9}(?!\\d)");
    /** 允许分组，但左右都不能从一条更长数字串的中间截出一段来冒充卡号。 */
    private static final Pattern CARD = Pattern.compile(
            "(?<!\\d)(?<!\\d[ -])(?:\\d[ -]?){15,18}\\d(?!\\d)(?![ -]\\d)");

    private SensitiveText() {
    }

    static String mask(String input) {
        if (input == null || input.isEmpty()) return input;
        String out = input;
        out = maskCodes(out);
        out = maskPattern(out, ID, 3, 4, false);
        out = maskPattern(out, PHONE, 3, 4, false);
        out = maskPattern(out, CARD, 4, 4, true);
        return out;
    }

    /** 只有带明确名称的数字才按验证码处理；单独出现的数字保持原样。 */
    private static String maskCodes(String input) {
        Matcher matcher = CODE.matcher(input);
        StringBuffer out = new StringBuffer();
        while (matcher.find()) {
            String stars = repeat('*', matcher.group(1).length());
            matcher.appendReplacement(out, Matcher.quoteReplacement(matcher.group(0)
                    .replace(matcher.group(1), stars)));
        }
        matcher.appendTail(out);
        return out.toString();
    }

    private static String maskPattern(String input, Pattern pattern, int first, int last,
                                      boolean requireLuhn) {
        Matcher matcher = pattern.matcher(input);
        StringBuffer out = new StringBuffer();
        while (matcher.find()) {
            String raw = matcher.group();
            String digits = raw.replaceAll("\\D", "");
            if (requireLuhn && !passesLuhn(digits)) {
                matcher.appendReplacement(out, Matcher.quoteReplacement(raw));
                continue;
            }
            String masked = maskDigits(raw, first, last);
            matcher.appendReplacement(out, Matcher.quoteReplacement(masked));
        }
        matcher.appendTail(out);
        return out.toString();
    }

    /** 保留首尾供人辨认，中间逐位替换；分隔符不动，避免把一串数字拼成另一个值。 */
    private static String maskDigits(String raw, int first, int last) {
        // 身份证末位 X 也占一个有效位；不能把它当空格跳过，否则首尾保留会错位。
        String significant = raw.replaceAll("[^0-9Xx]", "");
        int digitIndex = 0;
        StringBuilder out = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (!Character.isDigit(c) && c != 'X' && c != 'x') {
                out.append(c);
                continue;
            }
            boolean keep = digitIndex < first || digitIndex >= significant.length() - last;
            out.append(keep ? c : '*');
            digitIndex++;
        }
        return out.toString();
    }

    private static boolean passesLuhn(String digits) {
        int sum = 0;
        boolean doubleIt = false;
        for (int i = digits.length() - 1; i >= 0; i--) {
            int value = digits.charAt(i) - '0';
            if (doubleIt) {
                value *= 2;
                if (value > 9) value -= 9;
            }
            sum += value;
            doubleIt = !doubleIt;
        }
        return sum % 10 == 0;
    }

    private static String repeat(char c, int count) {
        StringBuilder out = new StringBuilder(count);
        for (int i = 0; i < count; i++) out.append(c);
        return out.toString();
    }
}
