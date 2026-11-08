package dev.mcpfabric.config;

import java.io.IOException;
import java.nio.file.AccessDeniedException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;

/**
 * Writes files that hold the bridge token (the config file, the discovery file). The text goes to a
 * temp file next to the target, which {@link Files#createTempFile} creates readable only by this
 * user on POSIX systems, and is then moved over the target: other local users never see the token,
 * and a crash mid-write leaves the old file instead of a cut one. On Windows the file takes the
 * folder's permissions.
 *
 * <p>A symbolic link is followed, so the file it points to is replaced, not the link. A read-only
 * target is not replaced. When an existing target cannot be replaced by a move (a single file
 * bind-mounted into a container, a folder this user may not create files in, a file held open on
 * Windows), it is written in place instead, as before.
 */
public final class PrivateFiles {
	private PrivateFiles() {}

	public static void write(Path file, String text) throws IOException {
		boolean exists = Files.exists(file);
		Path target = exists ? file.toRealPath() : file.toAbsolutePath();
		if (exists && !Files.isWritable(target)) throw new AccessDeniedException(target.toString(), null, "the file is read-only");
		Path dir = target.getParent();
		Files.createDirectories(dir);
		Path tmp;
		try {
			tmp = Files.createTempFile(dir, target.getFileName().toString() + ".", ".tmp");
		} catch (FileSystemException e) {
			if (!exists) throw e;
			writeInPlace(target, text);
			return;
		}
		try {
			Files.writeString(tmp, text);
			try {
				moveOver(tmp, target);
			} catch (FileSystemException e) {
				if (!exists) throw e;
				writeInPlace(target, text);
			}
		} finally {
			try {
				Files.deleteIfExists(tmp);
			} catch (IOException ignored) {
				// leaves an owner-only temp file behind; must not hide the outcome of the write
			}
		}
	}

	private static void moveOver(Path tmp, Path target) throws IOException {
		try {
			Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (AtomicMoveNotSupportedException e) {
			Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
		}
	}

	private static void writeInPlace(Path target, String text) throws IOException {
		Files.writeString(target, text);
		try {
			Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
		} catch (UnsupportedOperationException | IOException ignored) {
			// Windows, or a file this user may write but not chmod: it keeps its permissions
		}
	}
}
