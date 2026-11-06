package dev.mcpfabric.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AuditLogTest {
	private static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	@Test
	void lineHasTheOutcomeAndShortParamsButNotTheSessionIds() {
		String long300 = "x".repeat(300);
		String line = AuditLog.line(Instant.parse("2026-11-06T10:00:00Z"), "command.run",
				json("{\"command\":\"" + long300 + "\",\"session\":\"s1\",\"seq\":4,\"x\":3,\"pos\":{\"x\":1}}"),
				json("{\"ok\":false,\"error\":{\"code\":\"unavailable\",\"message\":\"m\"}}"), 12);
		JsonObject o = json(line);
		assertEquals("command.run", o.get("method").getAsString());
		assertFalse(o.get("ok").getAsBoolean());
		assertEquals("unavailable", o.get("error").getAsString());
		assertEquals(12, o.get("ms").getAsLong());
		JsonObject p = o.getAsJsonObject("params");
		assertFalse(p.has("session") || p.has("seq"));
		assertEquals(3, p.get("x").getAsInt());
		assertEquals(203, p.get("command").getAsString().length());
		assertEquals("{\"x\":1}", p.get("pos").getAsString());
	}

	@Test
	void onlyMethodsWithALastingEffectAreWritten(@TempDir Path dir) throws Exception {
		Path file = dir.resolve("logs").resolve("audit.jsonl");
		AuditLog log = new AuditLog(file);
		JsonObject ok = json("{\"ok\":true,\"result\":{}}");
		log.record("control.look", json("{\"yaw\":1}"), ok, 1);
		log.record("world.getBlock", json("{\"x\":1}"), ok, 1);
		log.record("world.setBlock", json("{\"x\":1,\"blockId\":\"minecraft:stone\"}"), ok, 2);
		log.record("players.kick", json("{\"player\":\"Alex\"}"), ok, 3);
		log.close();
		List<String> lines = Files.readAllLines(file);
		assertEquals(2, lines.size());
		assertTrue(lines.get(0).contains("\"world.setBlock\""));
		assertTrue(lines.get(1).contains("\"players.kick\""));
		log.record("world.setBlock", json("{}"), ok, 1); // after close: dropped, no exception
	}
}
