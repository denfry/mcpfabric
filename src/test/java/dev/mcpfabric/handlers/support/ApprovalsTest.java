package dev.mcpfabric.handlers.support;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ApprovalsTest {
	private static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	@Test
	void groupsCoverCommandsWorldEditsAndPlayerAdmin() {
		assertEquals("command", Approvals.groupOf("command.run", json("{\"command\":\"kill @e\"}")));
		assertEquals("command", Approvals.groupOf("chat.send", json("{\"message\":\"/op Steve\"}")));
		assertNull(Approvals.groupOf("chat.send", json("{\"message\":\"hello\"}")));
		assertEquals("world_write", Approvals.groupOf("world.fill", json("{}")));
		assertEquals("players_admin", Approvals.groupOf("players.kick", json("{}")));
		assertNull(Approvals.groupOf("control.look", json("{}")));
		for (String g : new String[] {"command", "world_write", "players_admin"}) assertTrue(Approvals.GROUPS.contains(g));
	}

	@Test
	void theSummaryShowsTheCommandAndCannotBeDisguised() {
		assertEquals("/kill @e", Approvals.summary("command.run", json("{\"command\":\"kill @e\"}")));
		assertEquals("/op Steve", Approvals.summary("chat.send", json("{\"message\":\"/op Steve\"}")));
		// The formatting code sign and the newline are dropped, so the text cannot pretend to be something else.
		assertEquals("/say hikclick", Approvals.summary("command.run", json("{\"command\":\"say hi\\u00a7kclick\\n\"}")));
		String longCmd = "say " + "x".repeat(400);
		assertEquals(163, Approvals.summary("command.run", json("{\"command\":\"" + longCmd + "\"}")).length());
		assertTrue(Approvals.summary("players.kick", json("{\"player\":\"Alex\"}")).startsWith("players.kick {\"player\":\"Alex\"}"));
	}

	@Test
	void answeringWithoutAnythingWaitingReturnsNull() {
		assertNull(Approvals.answer(0, true));
		assertNull(Approvals.answer(99, false));
		Approvals.denyAll();
		assertTrue(Approvals.pending().isEmpty());
	}
}
