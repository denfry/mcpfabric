package dev.mcpfabric.handlers.support;

import java.util.regex.Pattern;

/**
 * Takes server addresses and the user's home folder out of text read from the game's files (logs,
 * crash reports) before it goes over the bridge. Best effort: it knows IP addresses, the vanilla
 * "Connecting to host, port" line and the home path, not every way a mod might print a host name.
 */
public final class Redact {
	private static final Pattern CONNECTING = Pattern.compile("(Connecting to )\\S+?(?=, ?\\d{1,5}\\b)");
	private static final Pattern IPV4 = Pattern.compile("(?<![\\w.])(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?(?![\\w.])");
	private static final Pattern IPV6 = Pattern.compile("\\[[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(?:%[\\w.]+)?](?::\\d{1,5})?");

	private Redact() {}

	public static String text(String s) {
		return text(s, System.getProperty("user.home"));
	}

	static String text(String s, String home) {
		if (s == null || s.isEmpty()) return s;
		String out = CONNECTING.matcher(s).replaceAll("$1<server>");
		out = IPV4.matcher(out).replaceAll("<ip>");
		out = IPV6.matcher(out).replaceAll("<ip>");
		if (home != null && home.length() > 3) {
			out = out.replace(home, "~");
			out = out.replace(home.replace('\\', '/'), "~");
		}
		return out;
	}
}
