package dev.mcpfabric.handlers.support;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RedactTest {
	@Test
	void removesAddressesAndTheHomeFolder() {
		assertEquals("[Render thread/INFO]: Connecting to <server>, 25565",
				Redact.text("[Render thread/INFO]: Connecting to play.example.net, 25565", null));
		assertEquals("Disconnected <ip> and <ip> (lost connection)", Redact.text("Disconnected 203.0.113.7:25565 and [2001:db8::1]:25565 (lost connection)", null));
		assertEquals("at ~/mods/x.jar and ~/logs", Redact.text("at C:\\Users\\alex/mods/x.jar and C:/Users/alex/logs", "C:\\Users\\alex"));
	}

	@Test
	void keepsVersionsAndCoordinates() {
		String s = "Loading Minecraft 1.21.1 with Fabric Loader 0.16.10 at 12.5, 64.0, -3.25";
		assertEquals(s, Redact.text(s, null));
	}

	@Test
	void keepsTheTimeOfALogLine() {
		String s = "[11:20:33] [Render thread/WARN] (Minecraft) Missing sound [12:01:02.345]";
		assertEquals(s, Redact.text(s, null));
		assertEquals("<ip> <ip> <ip>", Redact.text("[::1] [fe80::1%eth0]:25565 [2001:db8:0:0:1:0:0:1]", null));
	}
}
