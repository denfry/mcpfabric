package dev.mcpfabric.client.handlers;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.bridge.ThrowingSupplier;
import dev.mcpfabric.client.BotController;
import dev.mcpfabric.client.ClientCompat;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.client.ClientTasks;
import dev.mcpfabric.handlers.support.Levels;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
//? if >=1.21.2 {
import net.minecraft.network.protocol.game.ServerboundPlayerInputPacket;
import net.minecraft.world.entity.player.Input;
//?} else
/*import net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket;*/
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Interaction: break/place blocks, use items, attack/use entities, drop held item. */
public final class InteractHandlers {
	private InteractHandlers() {}

	public static void register(RpcRouter router) {
		router.register("interact.breakBlock", ctx -> ClientMc.call(() -> {
			requireControl();
			MultiPlayerGameMode gm = ClientMc.gameMode();
			LocalPlayer p = ClientMc.player();
			BlockPos pos = BlockPos.containing(ctx.getDouble("x"), ctx.getDouble("y"), ctx.getDouble("z"));
			Direction face = faceToward(pos, p.getEyePosition());
			String mode = ctx.optString("mode", "survival");
			JsonObject o = new JsonObject();
			if ("instant".equals(mode)) {
				boolean broke = gm.destroyBlock(pos);
				swingAttack(p);
				o.addProperty("broke", broke);
				o.addProperty("mode", "instant");
			} else {
				gm.startDestroyBlock(pos, face);
				BotController.get().startMining(pos, face);
				swingAttack(p);
				o.addProperty("started", true);
				o.addProperty("mode", "survival");
				o.addProperty("note", "Mining continues each tick; poll get_block to confirm it broke.");
			}
			return o;
		}));

		router.register("interact.placeBlock", ctx -> ClientMc.call(() -> {
			requireControl();
			MultiPlayerGameMode gm = ClientMc.gameMode();
			LocalPlayer p = ClientMc.player();
			BlockPos pos = BlockPos.containing(ctx.getDouble("x"), ctx.getDouble("y"), ctx.getDouble("z"));
			Direction face = parseFace(ctx.optString("face", "up"));
			Vec3 hitLoc = new Vec3(
					pos.getX() + 0.5 + face.getStepX() * 0.5,
					pos.getY() + 0.5 + face.getStepY() * 0.5,
					pos.getZ() + 0.5 + face.getStepZ() * 0.5);
			BlockHitResult hit = new BlockHitResult(hitLoc, face, pos, false);
			InteractionResult result = withSneak(p, ctx.optBool("sneak", false), () -> gm.useItemOn(p, InteractionHand.MAIN_HAND, hit));
			swingUse(p);
			JsonObject o = new JsonObject();
			o.addProperty("result", String.valueOf(result));
			return o;
		}));

		router.register("interact.useItem", ctx -> ClientMc.call(() -> {
			requireControl();
			MultiPlayerGameMode gm = ClientMc.gameMode();
			LocalPlayer p = ClientMc.player();
			InteractionResult result = withSneak(p, ctx.optBool("sneak", false), () -> gm.useItem(p, InteractionHand.MAIN_HAND));
			JsonObject o = new JsonObject();
			o.addProperty("result", String.valueOf(result));
			return o;
		}));

		router.register("interact.holdUse", ctx -> {
			requireControl();
			int ticks = ctx.getInt("ticks");
			if (ticks < 1 || ticks > MAX_HOLD_TICKS) throw RpcException.badRequest("ticks must be 1-" + MAX_HOLD_TICKS + ".");
			BlockPos pos = BlockPos.containing(ctx.getDouble("x"), ctx.getDouble("y"), ctx.getDouble("z"));
			Direction face = parseFace(ctx.optString("face", "up"));
			boolean sneak = ctx.optBool("sneak", false);
			CompletableFuture<JsonObject> done = new CompletableFuture<>();
			ClientMc.call(() -> {
				Minecraft mc = ClientMc.mc();
				LocalPlayer p = ClientMc.player();
				if (ClientCompat.screen(mc) != null) throw RpcException.badRequest("Close the open screen first (close_screen).");
				Vec3 aim = faceCentre(pos, face);
				JsonObject before = snapshot(p, pos);
				int[] elapsed = {0};
				int[] settle = {SETTLE_TICKS};
				hold(mc, p, aim, sneak);
				ClientTasks.add(client -> {
					LocalPlayer pl = client.player;
					if (pl == null) {
						done.completeExceptionally(RpcException.noClientPlayer());
						return true;
					}
					if (elapsed[0] < ticks) {
						if (ClientCompat.screen(client) != null) {
							// Holding right-click opened a screen: stop there, as a player's hand would.
							release(client, sneak);
							elapsed[0] = ticks;
						} else if (++elapsed[0] < ticks) {
							hold(client, pl, aim, sneak);
						} else {
							release(client, sneak);
						}
						return false;
					}
					if (settle[0]-- > 0) return false; // let the server's answer arrive
					JsonObject o = new JsonObject();
					o.addProperty("ticks", ticks);
					o.add("before", before);
					o.add("after", snapshot(pl, pos));
					o.addProperty("screenNow", ClientCompat.screenName(client));
					done.complete(o);
					return true;
				});
				return null;
			});
			return await(done, ticks + SETTLE_TICKS);
		});

		router.register("interact.consumeHeld", ctx -> {
			requireControl();
			int timeout = ctx.optInt("timeoutTicks", 100);
			if (timeout < 1 || timeout > MAX_CONSUME_TICKS) throw RpcException.badRequest("timeoutTicks must be 1-" + MAX_CONSUME_TICKS + ".");
			CompletableFuture<JsonObject> done = new CompletableFuture<>();
			JsonObject early = ClientMc.call(() -> {
				Minecraft mc = ClientMc.mc();
				LocalPlayer p = ClientMc.player();
				if (p.getMainHandItem().isEmpty()) throw RpcException.badRequest("The main hand is empty.");
				JsonObject before = snapshot(p, null);
				InteractionResult result = ClientMc.gameMode().useItem(p, InteractionHand.MAIN_HAND);
				if (!p.isUsingItem()) {
					// Not a held use (food while full, a non-consumable): nothing to wait for.
					JsonObject o = new JsonObject();
					o.addProperty("started", false);
					o.addProperty("result", String.valueOf(result));
					o.add("before", before);
					o.add("after", snapshot(p, null));
					return o;
				}
				// Vanilla releases the use as soon as the use key is up, so hold it for the duration.
				mc.options.keyUse.setDown(true);
				int[] elapsed = {0};
				int[] settle = {-1};
				ClientTasks.add(client -> {
					LocalPlayer pl = client.player;
					if (pl == null) {
						done.completeExceptionally(RpcException.noClientPlayer());
						return true;
					}
					if (settle[0] < 0) {
						elapsed[0]++;
						if (pl.isUsingItem() && elapsed[0] < timeout) return false;
						// Released before the next tick, or the held key would start on the next item.
						client.options.keyUse.setDown(false);
						if (pl.isUsingItem()) pl.stopUsingItem();
						settle[0] = SETTLE_TICKS;
						return false;
					}
					if (settle[0]-- > 0) return false;
					JsonObject o = new JsonObject();
					o.addProperty("started", true);
					o.addProperty("completed", elapsed[0] < timeout);
					o.addProperty("ticks", elapsed[0]);
					o.add("before", before);
					o.add("after", snapshot(pl, null));
					done.complete(o);
					return true;
				});
				return null;
			});
			return early != null ? early : await(done, timeout + SETTLE_TICKS);
		});

		router.register("interact.attackEntity", ctx -> ClientMc.call(() -> {
			requireControl();
			MultiPlayerGameMode gm = ClientMc.gameMode();
			LocalPlayer p = ClientMc.player();
			Entity e = findEntity(ctx.getString("uuid"));
			gm.attack(p, e);
			swingAttack(p);
			return Json.ok("attacked " + e.getName().getString());
		}));

		router.register("interact.useEntity", ctx -> ClientMc.call(() -> {
			requireControl();
			MultiPlayerGameMode gm = ClientMc.gameMode();
			LocalPlayer p = ClientMc.player();
			Entity e = findEntity(ctx.getString("uuid"));
			//? if <26.1 {
			InteractionResult result = gm.interact(p, e, InteractionHand.MAIN_HAND);
			//?} else
			/*InteractionResult result = gm.interact(p, e, new net.minecraft.world.phys.EntityHitResult(e), InteractionHand.MAIN_HAND);*/
			JsonObject o = new JsonObject();
			o.addProperty("result", String.valueOf(result));
			return o;
		}));

		router.register("interact.dropItem", ctx -> ClientMc.call(() -> {
			requireControl();
			LocalPlayer p = ClientMc.player();
			boolean whole = ctx.optBool("wholeStack", false);
			//? if <26.3 {
			p.drop(whole);
			//?} else
			/*ClientMc.gameMode().dropItem(p, whole);*/
			return Json.ok(whole ? "dropped stack" : "dropped one");
		}));
	}

	/** Longest {@code interact.holdUse}: the call blocks, and must answer inside the MCP client's timeout. */
	private static final int MAX_HOLD_TICKS = 200;
	/** Longest {@code interact.consumeHeld}. */
	private static final int MAX_CONSUME_TICKS = 240;
	/** Ticks to wait after a hold so the server's food / inventory / block updates have arrived. */
	private static final int SETTLE_TICKS = 5;

	/** Aim at {@code aim} and keep the use key (and shift) down for the next tick. */
	private static void hold(Minecraft mc, LocalPlayer p, Vec3 aim, boolean sneak) {
		lookAt(p, aim);
		mc.options.keyUse.setDown(true);
		if (sneak) mc.options.keyShift.setDown(true);
	}

	private static void release(Minecraft mc, boolean sneak) {
		mc.options.keyUse.setDown(false);
		if (sneak) mc.options.keyShift.setDown(false);
	}

	private static void lookAt(LocalPlayer p, Vec3 target) {
		Vec3 eye = p.getEyePosition();
		double dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
		double horiz = Math.sqrt(dx * dx + dz * dz);
		float yaw = (float) (Mth.atan2(dz, dx) * (180.0 / Math.PI)) - 90.0F;
		float pitch = (float) (-(Mth.atan2(dy, horiz) * (180.0 / Math.PI)));
		p.setYRot(yaw);
		p.setXRot(Mth.clamp(pitch, -90.0F, 90.0F));
		p.setYHeadRot(yaw);
	}

	/** Centre of a block face, nudged inwards so the crosshair ray lands on that face. */
	private static Vec3 faceCentre(BlockPos pos, Direction face) {
		return new Vec3(
				pos.getX() + 0.5 + face.getStepX() * 0.499,
				pos.getY() + 0.5 + face.getStepY() * 0.499,
				pos.getZ() + 0.5 + face.getStepZ() * 0.499);
	}

	/** Food, saturation, held item and (optionally) the target block, to report what a hold changed. */
	private static JsonObject snapshot(LocalPlayer p, BlockPos pos) {
		JsonObject o = new JsonObject();
		o.addProperty("food", p.getFoodData().getFoodLevel());
		o.addProperty("saturation", p.getFoodData().getSaturationLevel());
		o.addProperty("health", p.getHealth());
		o.add("mainHand", Levels.itemJson(p.getMainHandItem()));
		if (pos != null) o.add("block", Levels.describeBlock(p.level(), pos, p.level().getBlockState(pos)));
		return o;
	}

	/** Wait on the HTTP worker thread for a multi-tick job: 50 ms a tick, plus a margin. */
	private static JsonObject await(CompletableFuture<JsonObject> done, int ticks) throws RpcException {
		try {
			return done.get(ticks * 50L + 5000L, TimeUnit.MILLISECONDS);
		} catch (TimeoutException e) {
			throw new RpcException("timeout", "The hold did not finish in time (is the game frozen?).");
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new RpcException("interrupted", "Interrupted while waiting for the hold to finish.");
		} catch (ExecutionException e) {
			if (e.getCause() instanceof RpcException rpc) throw rpc;
			throw new RpcException("internal", String.valueOf(e.getCause()));
		}
	}

	/**
	 * Runs {@code action} with the shift key held on both sides, then restores it, so a
	 * shift-right-click needs no separate (racy) movement call. The server learns about shift from a
	 * packet the client otherwise sends once per tick; 1.21.2 replaced the press / release player
	 * command with the whole input state ({@code ServerboundPlayerInputPacket}).
	 */
	private static <T> T withSneak(LocalPlayer p, boolean sneak, ThrowingSupplier<T> action) throws RpcException {
		if (!sneak || p.isShiftKeyDown()) return action.get();
		setShift(p, true);
		try {
			return action.get();
		} finally {
			setShift(p, false);
		}
	}

	private static void setShift(LocalPlayer p, boolean down) {
		//? if >=1.21.2 {
		Input i = p.input.keyPresses;
		Input now = new Input(i.forward(), i.backward(), i.left(), i.right(), i.jump(), down, i.sprint());
		p.input.keyPresses = now;
		p.connection.send(new ServerboundPlayerInputPacket(now));
		//?} else {
		/*p.input.shiftKeyDown = down;
		p.connection.send(new ServerboundPlayerCommandPacket(p, down
				? ServerboundPlayerCommandPacket.Action.PRESS_SHIFT_KEY
				: ServerboundPlayerCommandPacket.Action.RELEASE_SHIFT_KEY));
		*///?}
		p.setShiftKeyDown(down);
	}

	/** Main-hand swing for attacking / mining. 26.3 made the swing animation an explicit, per-item argument. */
	private static void swingAttack(LocalPlayer p) {
		//? if <26.3 {
		p.swing(InteractionHand.MAIN_HAND);
		//?} else
		/*p.swing(InteractionHand.MAIN_HAND, p.getMainHandItem().getAttackAnimation(), false);*/
	}

	/** Main-hand swing for using an item on a block. */
	private static void swingUse(LocalPlayer p) {
		//? if <26.3 {
		p.swing(InteractionHand.MAIN_HAND);
		//?} else
		/*p.swing(InteractionHand.MAIN_HAND, p.getMainHandItem().getInteractAnimation(), false);*/
	}

	private static void requireControl() throws RpcException {
		if (!McpFabric.config().enablePlayerControl) {
			throw RpcException.unavailable("Player control is disabled in mcpfabric.config.json (enablePlayerControl=false).");
		}
	}

	private static Entity findEntity(String uuidStr) throws RpcException {
		UUID uuid;
		try {
			uuid = UUID.fromString(uuidStr);
		} catch (IllegalArgumentException e) {
			throw RpcException.badRequest("Invalid UUID: " + uuidStr);
		}
		for (Entity e : ClientMc.level().entitiesForRendering()) {
			if (e.getUUID().equals(uuid)) return e;
		}
		throw RpcException.notFound("No visible entity with uuid " + uuid);
	}

	private static Direction parseFace(String name) {
		Direction d = Direction.byName(name.toLowerCase());
		return d == null ? Direction.UP : d;
	}

	private static Direction faceToward(BlockPos pos, Vec3 eye) {
		double dx = eye.x - (pos.getX() + 0.5);
		double dy = eye.y - (pos.getY() + 0.5);
		double dz = eye.z - (pos.getZ() + 0.5);
		double ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
		if (ax >= ay && ax >= az) return dx > 0 ? Direction.EAST : Direction.WEST;
		if (az >= ax && az >= ay) return dz > 0 ? Direction.SOUTH : Direction.NORTH;
		return dy > 0 ? Direction.UP : Direction.DOWN;
	}
}
