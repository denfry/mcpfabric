package dev.mcpfabric.config;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class McpConfigTest {
	@TempDir
	Path dir;

	private static boolean present(String className) {
		try {
			Class.forName(className, false, McpConfigTest.class.getClassLoader());
			return true;
		} catch (ClassNotFoundException e) {
			return false;
		}
	}

	@Test
	void aFirstRunWritesTheDefaultsWithFreshSecrets() throws Exception {
		Path file = dir.resolve("mcpfabric.config.json");
		McpConfig cfg = McpConfig.load(file);
		assertTrue(cfg.enableCommands);
		assertEquals(32, cfg.token.length());
		assertFalse(cfg.token.equals(cfg.readToken));
		JsonObject saved = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
		assertEquals(cfg.token, saved.get("token").getAsString());
		// No temp file is left next to it.
		try (Stream<Path> files = Files.list(dir)) {
			assertEquals(1, files.count());
		}
	}

	@Test
	void theUsersSettingsAreKeptAndMissingSecretsAdded() throws Exception {
		Path file = dir.resolve("mcpfabric.config.json");
		Files.writeString(file, "{\"enableCommands\": false, \"port\": 25610}");
		McpConfig cfg = McpConfig.load(file);
		assertFalse(cfg.enableCommands);
		assertTrue(cfg.enableWorldWrite);
		assertEquals(25610, cfg.port);
		assertFalse(cfg.token.isBlank());
		JsonObject saved = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
		assertFalse(saved.get("enableCommands").getAsBoolean());
		assertEquals(cfg.token, saved.get("token").getAsString());
	}

	@Test
	void anUnreadableFileLocksEveryCapabilityAndIsLeftAsItIs() throws Exception {
		// The error is logged through McpFabric's slf4j logger, which NeoForge nodes do not put on the
		// test classpath; this runs on the Fabric nodes.
		assumeTrue(present("org.slf4j.Logger"), "slf4j is not on this node's test classpath");
		Path file = dir.resolve("mcpfabric.config.json");
		String broken = "{\"enableCommands\": false,, \"token\": \"abc\"";
		Files.writeString(file, broken);
		McpConfig cfg = McpConfig.load(file);
		assertFalse(cfg.enableCommands);
		assertFalse(cfg.enableWorldWrite);
		assertFalse(cfg.enablePlayerControl);
		assertFalse(cfg.enableVision);
		assertFalse(cfg.enableUiControl);
		assertFalse(cfg.enableSupervisedControl);
		assertTrue(cfg.requireAuth);
		assertFalse(cfg.writeDiscoveryFile);
		assertFalse(cfg.token.isBlank());
		assertEquals(broken, Files.readString(file));
	}

	@Test
	void anEmptyFileIsUnreadableNotAFirstRun() throws Exception {
		assumeTrue(present("org.slf4j.Logger"), "slf4j is not on this node's test classpath");
		Path file = dir.resolve("mcpfabric.config.json");
		Files.writeString(file, "  \n");
		McpConfig cfg = McpConfig.load(file);
		assertFalse(cfg.enableCommands);
		assertFalse(cfg.enableWorldWrite);
		assertFalse(cfg.writeDiscoveryFile);
		assertEquals("  \n", Files.readString(file));
	}

	@Test
	void aCompleteFileIsNotRewritten() throws Exception {
		Path file = dir.resolve("mcpfabric.config.json");
		McpConfig.load(file);
		String first = Files.readString(file);
		FileTime old = FileTime.from(Instant.parse("2020-01-01T00:00:00Z"));
		Files.setLastModifiedTime(file, old);
		McpConfig.load(file);
		assertEquals(first, Files.readString(file));
		assertEquals(old, Files.getLastModifiedTime(file));
	}

	@Test
	void aSymbolicLinkIsFollowedNotReplaced() throws Exception {
		Path real = dir.resolve("shared.json");
		Files.writeString(real, "{\"enableCommands\": false}");
		Path link = dir.resolve("mcpfabric.config.json");
		try {
			Files.createSymbolicLink(link, real);
		} catch (UnsupportedOperationException | IOException e) {
			assumeTrue(false, "symbolic links are not available here: " + e);
		}
		McpConfig cfg = McpConfig.load(link);
		assertTrue(Files.isSymbolicLink(link));
		assertFalse(cfg.enableCommands);
		JsonObject saved = JsonParser.parseString(Files.readString(real)).getAsJsonObject();
		assertEquals(cfg.token, saved.get("token").getAsString());
	}

	@Test
	void theFileWithTheTokenIsReadableOnlyByItsOwner() throws Exception {
		Path file = dir.resolve("mcpfabric.config.json");
		McpConfig.load(file);
		assumeTrue(Files.getFileStore(file).supportsFileAttributeView("posix"), "no POSIX permissions here");
		assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(file)));
	}
}
