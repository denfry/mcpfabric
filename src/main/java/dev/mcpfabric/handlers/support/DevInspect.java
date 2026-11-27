package dev.mcpfabric.handlers.support;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.Collection;
import java.util.function.Function;

/** Game-independent parts of the dev world tools: the watched region, its diff and short value text. */
public final class DevInspect {
	public static final int MAX_VALUE_CHARS = 200;

	private DevInspect() {}

	/** An inclusive block region; samples of it run y, then x, then z. */
	public record Box(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
		public static Box of(int ax, int ay, int az, int bx, int by, int bz) {
			return new Box(Math.min(ax, bx), Math.min(ay, by), Math.min(az, bz), Math.max(ax, bx), Math.max(ay, by), Math.max(az, bz));
		}

		public long volume() {
			return (long) (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
		}
	}

	/**
	 * Appends the positions whose sample differs between two samples (by identity: block states are
	 * shared instances; null is an unloaded chunk); returns true when the list hit {@code max}.
	 */
	public static <S> boolean diff(Box box, S[] before, S[] after, int tick, JsonArray out, int max, Function<S, String> name) {
		int sx = box.maxX() - box.minX() + 1, sz = box.maxZ() - box.minZ() + 1;
		for (int i = 0; i < after.length; i++) {
			if (before[i] == after[i]) continue;
			if (out.size() >= max) return true;
			JsonObject c = new JsonObject();
			c.addProperty("x", box.minX() + (i / sz) % sx);
			c.addProperty("y", box.minY() + i / (sx * sz));
			c.addProperty("z", box.minZ() + i % sz);
			c.addProperty("from", before[i] == null ? "unloaded" : name.apply(before[i]));
			c.addProperty("to", after[i] == null ? "unloaded" : name.apply(after[i]));
			c.addProperty("tick", tick);
			out.add(c);
		}
		return false;
	}

	/** A value as short text: collections by size, anything else by its text, cut to a limit. */
	public static String shortText(Object v) {
		String s = v instanceof Collection<?> c ? c.size() + " item" + (c.size() == 1 ? "" : "s") : String.valueOf(v);
		return s.length() > MAX_VALUE_CHARS ? s.substring(0, MAX_VALUE_CHARS) + "..." : s;
	}

	/** Vanilla classes by simple name; others (mods) by full name, so the mod can be told. */
	public static String className(Class<?> c) {
		String n = c.getName();
		return n.startsWith("net.minecraft.") && !c.getSimpleName().isEmpty() ? c.getSimpleName() : n;
	}
}
