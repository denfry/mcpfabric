package dev.mcpfabric.config;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * Writes files that hold the bridge token (the config file, the discovery file). The text goes to a
 * temp file next to the target, which {@link Files#createTempFile} creates readable only by this
 * user on POSIX systems, and is then moved over the target: other local users never see the token,
 * and a crash mid-write leaves the old file instead of a cut one. On Windows the file takes the
 * folder's permissions.
 */
public final class PrivateFiles {
	private PrivateFiles() {}

	public static void write(Path file, String text) throws IOException {
		Path dir = file.toAbsolutePath().getParent();
		Files.createDirectories(dir);
		Path tmp = Files.createTempFile(dir, file.getFileName().toString() + ".", ".tmp");
		try {
			Files.writeString(tmp, text);
			try {
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			} catch (AtomicMoveNotSupportedException e) {
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
			}
		} finally {
			Files.deleteIfExists(tmp);
		}
	}
}
