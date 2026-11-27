package dev.mcpfabric.handlers.support;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DevInspectTest {
	// 2 wide (x), 2 high (y), 3 deep (z); samples run y, then x, then z.
	private static final DevInspect.Box BOX = new DevInspect.Box(10, 64, -3, 11, 65, -1);

	@Test
	void boxIsInclusiveWhicheverCornerComesFirst() {
		assertEquals(BOX, DevInspect.Box.of(11, 65, -1, 10, 64, -3));
		assertEquals(12, BOX.volume());
	}

	@Test
	void diffReportsChangedPositionsWithTheirCoordinates() {
		String[] before = new String[12];
		Arrays.fill(before, "air");
		String[] after = before.clone();
		after[0] = "stone"; // y 64, x 10, z -3
		after[5] = "water"; // y 64, x 11, z -1
		after[11] = null;   // y 65, x 11, z -1: chunk unloaded
		JsonArray out = new JsonArray();
		assertFalse(DevInspect.diff(BOX, before, after, 7, out, 10, Function.identity()));
		assertEquals(3, out.size());
		assertChange(out.get(0).getAsJsonObject(), 10, 64, -3, "air", "stone");
		assertChange(out.get(1).getAsJsonObject(), 11, 64, -1, "air", "water");
		assertChange(out.get(2).getAsJsonObject(), 11, 65, -1, "air", "unloaded");
		assertEquals(7, out.get(0).getAsJsonObject().get("tick").getAsInt());
	}

	@Test
	void diffStopsAtTheLimit() {
		String[] before = new String[12];
		String[] after = new String[12];
		Arrays.fill(before, "a");
		Arrays.fill(after, "b");
		JsonArray out = new JsonArray();
		assertTrue(DevInspect.diff(BOX, before, after, 1, out, 4, Function.identity()));
		assertEquals(4, out.size());
	}

	@Test
	void valuesAreShort() {
		assertEquals("3 items", DevInspect.shortText(List.of(1, 2, 3)));
		assertEquals("1 item", DevInspect.shortText(List.of(1)));
		assertEquals("Object", DevInspect.shortText(new Object()));
		assertEquals(DevInspect.MAX_VALUE_CHARS + 3, DevInspect.shortText("x".repeat(500)).length());
	}

	@Test
	void modClassesAreNamedInFull() {
		assertEquals("java.lang.String", DevInspect.className(String.class));
	}

	private static void assertChange(JsonObject c, int x, int y, int z, String from, String to) {
		assertEquals(x, c.get("x").getAsInt());
		assertEquals(y, c.get("y").getAsInt());
		assertEquals(z, c.get("z").getAsInt());
		assertEquals(from, c.get("from").getAsString());
		assertEquals(to, c.get("to").getAsString());
	}
}
