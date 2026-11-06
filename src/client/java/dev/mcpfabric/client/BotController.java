package dev.mcpfabric.client;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.client.handlers.InteractHandlers;
import dev.mcpfabric.client.nav.LevelNavWorld;
import dev.mcpfabric.nav.NavPlanner;
import dev.mcpfabric.nav.NavPos;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Options;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.List;

/**
 * Per-tick driver for the local player: holds desired movement input (applied through key
 * mappings so it integrates with the vanilla input pipeline), single-shot jumps, survival mining,
 * and navigation following: walking, swimming, climbing, opening doors, digging through blocks and
 * pillaring up, one planned step at a time. The single instance ticks from
 * {@code ClientTickEvents.END_CLIENT_TICK}.
 */
public final class BotController {
	private static final BotController INSTANCE = new BotController();

	public static BotController get() {
		return INSTANCE;
	}

	private BotController() {}

	// desired movement
	private volatile boolean fwd, back, left, right, jumpHeld, sneak, sprint;
	private int jumpOnceTicks = 0;
	/** Jump held by navigation (swimming, climbing), apart from the jump a movement command holds. */
	private boolean navJump;

	// survival mining
	/** Extra ticks allowed beyond a block's expected break time before mining is given up. */
	private static final int MINING_GRACE_TICKS = 40;
	private BlockPos miningPos;
	private Direction miningFace = Direction.UP;
	private int miningTicks;
	/** The current mining was started by navigation: its result goes to the walker, not to an event. */
	private boolean navMining;
	private String navMiningResult;

	// navigation
	private List<NavPlanner.Step> path;
	private int pathIndex;
	private NavPos navStart;
	private BlockPos navTarget;
	private double reachRadius = 1.0;
	private boolean navSprint;
	private long navDeadline;
	private double lastDist = Double.MAX_VALUE;
	private int stuckTicks;
	/** Ticks without getting closer to the target; unlike stuckTicks, the unstick jump does not reset it. */
	private int ticksWithoutProgress;
	/** Navigation counts as stuck after this many ticks (3 s) without getting closer. */
	private static final int STUCK_TICKS = 60;
	private volatile String navState = "idle";
	private boolean drivingKeys;
	/** Ticks spent on the current step, and the per-step state of digging, pillaring and doors. */
	private int stepTicks;
	private int settleTicks;
	private int digsThisStep;
	private boolean pillarPlaced;
	private int doorCooldown;
	/** One step may take this long (45 s) before navigation gives up. */
	private static final int STEP_TICKS = 900;
	/** Blocks mined for one step before giving up (falling sand or gravel keeps refilling it). */
	private static final int MAX_DIGS_PER_STEP = 12;
	/** Ticks to wait after the last dig of a step, so falling blocks land before the body moves in. */
	private static final int SETTLE_TICKS = 6;
	/** Ticks a pillar step may take to get its block placed. */
	private static final int PILLAR_TICKS = 100;

	// --- public control surface (called from handlers, on the render thread) ----------------

	public synchronized void setMovement(Boolean f, Boolean b, Boolean l, Boolean r, Boolean jump, Boolean sn, Boolean sp) {
		if (f != null) fwd = f;
		if (b != null) back = b;
		if (l != null) left = l;
		if (r != null) right = r;
		if (jump != null) jumpHeld = jump;
		if (sn != null) sneak = sn;
		if (sp != null) sprint = sp;
	}

	public synchronized void stopAllMovement() {
		fwd = back = left = right = jumpHeld = sneak = sprint = false;
		jumpOnceTicks = 0;
	}

	/** Whether the bot forced movement keys down on the last tick (movement or navigation running). */
	public synchronized boolean drivingKeys() {
		return drivingKeys;
	}

	public synchronized void jumpOnce() {
		jumpOnceTicks = Math.max(jumpOnceTicks, 2);
	}

	public synchronized void startMining(BlockPos pos, Direction face) {
		this.navMining = false;
		this.miningPos = pos;
		this.miningFace = face;
		this.miningTicks = 0;
	}

	public synchronized void stopMining() {
		this.miningPos = null;
	}

	public synchronized void startNavigation(List<NavPlanner.Step> path, BlockPos start, BlockPos target, double reachRadius,
			boolean sprint, long deadlineMillis) {
		this.path = path;
		this.pathIndex = 0;
		this.navStart = new NavPos(start.getX(), start.getY(), start.getZ());
		this.navTarget = target;
		this.reachRadius = reachRadius;
		this.navSprint = sprint;
		this.navDeadline = deadlineMillis;
		this.lastDist = Double.MAX_VALUE;
		this.stuckTicks = 0;
		this.ticksWithoutProgress = 0;
		this.navState = "navigating";
		resetStep();
	}

	public synchronized void stopNavigation(String reason) {
		stopNavigationInternal(reason);
	}

	public synchronized JsonObject statusJson() {
		JsonObject o = new JsonObject();
		boolean active = path != null;
		o.addProperty("active", active);
		o.addProperty("state", navState);
		if (navTarget != null) {
			JsonObject t = new JsonObject();
			t.addProperty("x", navTarget.getX());
			t.addProperty("y", navTarget.getY());
			t.addProperty("z", navTarget.getZ());
			o.add("target", t);
		}
		if (active) {
			o.addProperty("remainingNodes", Math.max(0, path.size() - pathIndex));
			if (pathIndex < path.size()) o.addProperty("move", path.get(pathIndex).move().id());
			o.addProperty("ticksWithoutProgress", ticksWithoutProgress);
		}
		o.addProperty("stuck", active && ticksWithoutProgress >= STUCK_TICKS);
		LocalPlayer p = Minecraft.getInstance().player;
		if (p != null && navTarget != null) {
			o.addProperty("distance", p.position().distanceTo(Vec3.atBottomCenterOf(navTarget)));
		}
		return o;
	}

	// --- tick --------------------------------------------------------------------------------

	public void onClientTick(Minecraft mc) {
		LocalPlayer p = mc.player;
		if (p == null) {
			return;
		}

		synchronized (this) {
			if (path != null) {
				steer(mc, p);
			}
			if (path == null && navMining) {
				// Navigation ended (stopped, timed out) while it was digging.
				if (mc.gameMode != null) mc.gameMode.stopDestroyBlock();
				miningPos = null;
				navMining = false;
			}
			boolean driving = fwd || back || left || right || jumpHeld || navJump || sneak || sprint || jumpOnceTicks > 0 || path != null;
			if (driving) {
				applyKeys(mc.options);
				drivingKeys = true;
			} else if (drivingKeys) {
				// Release any keys the bot forced down instead of continuing to stomp on them
				// every tick — without this, real keyboard input can never move the player
				// again once the bot has issued any movement command.
				releaseKeys(mc.options);
				drivingKeys = false;
			}
			if (jumpOnceTicks > 0) jumpOnceTicks--;
			tickMining(mc);
		}
	}

	private void applyKeys(Options o) {
		o.keyUp.setDown(fwd);
		o.keyDown.setDown(back);
		o.keyLeft.setDown(left);
		o.keyRight.setDown(right);
		o.keyShift.setDown(sneak);
		o.keySprint.setDown(sprint);
		o.keyJump.setDown(jumpHeld || navJump || jumpOnceTicks > 0);
	}

	private void releaseKeys(Options o) {
		o.keyUp.setDown(false);
		o.keyDown.setDown(false);
		o.keyLeft.setDown(false);
		o.keyRight.setDown(false);
		o.keyShift.setDown(false);
		o.keySprint.setDown(false);
		o.keyJump.setDown(false);
	}

	private void tickMining(Minecraft mc) {
		if (miningPos == null) return;
		MultiPlayerGameMode gm = mc.gameMode;
		LocalPlayer p = mc.player;
		if (gm == null || mc.level == null || p == null) {
			miningPos = null;
			return;
		}
		BlockState state = mc.level.getBlockState(miningPos);
		if (state.isAir()) {
			gm.stopDestroyBlock();
			finishMining("broken");
			return;
		}
		// Mining used to go on forever when the block could not break: give up and say why.
		if (!ClientMc.canReachBlock(p, miningPos, 1.0)) {
			gm.stopDestroyBlock();
			finishMining("out_of_reach");
			return;
		}
		float perTick = state.getDestroyProgress(p, mc.level, miningPos);
		if (perTick <= 0) {
			gm.stopDestroyBlock();
			finishMining("unbreakable");
			return;
		}
		if (++miningTicks > Math.ceil(1.0 / perTick) + MINING_GRACE_TICKS) {
			gm.stopDestroyBlock();
			finishMining("no_progress");
			return;
		}
		gm.continueDestroyBlock(miningPos, miningFace);
	}

	/** Ends survival mining and reports the outcome as a {@code mining_finished} event (see poll_events). */
	private void finishMining(String result) {
		if (navMining) {
			navMining = false;
			navMiningResult = result;
			miningPos = null;
			return;
		}
		JsonObject d = new JsonObject();
		d.addProperty("x", miningPos.getX());
		d.addProperty("y", miningPos.getY());
		d.addProperty("z", miningPos.getZ());
		d.addProperty("result", result);
		d.addProperty("ticks", miningTicks);
		miningPos = null;
		McpFabric.events().emit("mining_finished", d);
	}

	private void steer(Minecraft mc, LocalPlayer p) {
		if (System.currentTimeMillis() > navDeadline) {
			stopNavigationInternal("timeout");
			return;
		}
		Vec3 tgt = Vec3.atBottomCenterOf(navTarget);
		if (p.position().distanceTo(tgt) <= Math.max(reachRadius, 0.6)) {
			stopNavigationInternal("reached");
			return;
		}
		if (pathIndex >= path.size()) {
			stopNavigationInternal("reached");
			return;
		}
		if (mc.level == null || mc.gameMode == null) {
			stopNavigationInternal("no_world");
			return;
		}
		NavPlanner.Step step = path.get(pathIndex);
		BlockPos node = blockPos(step.pos());
		if (++stepTicks > STEP_TICKS) {
			stopNavigationInternal("step_timeout");
			return;
		}
		if (doorCooldown > 0) doorCooldown--;
		navJump = false;

		if (!step.dig().isEmpty() && !clearCells(mc, p, step)) return;
		openDoors(mc, p, node);
		switch (step.move()) {
			case PILLAR -> pillar(mc, p, node);
			case CLIMB -> climb(p, node, step.pos().y() > previousPos().y());
			default -> walk(p, node, step.move());
		}
		if (path == null) return;

		double dist = p.position().distanceTo(tgt);
		if (dist < lastDist - 0.01) {
			stuckTicks = 0;
			ticksWithoutProgress = 0;
			lastDist = dist;
		} else {
			ticksWithoutProgress++;
			if (++stuckTicks > STUCK_TICKS && step.move() != NavPlanner.Move.PILLAR && step.move() != NavPlanner.Move.CLIMB) {
				stuckTicks = 0;
				jumpOnceTicks = Math.max(jumpOnceTicks, 1);
			}
		}
	}

	private NavPos previousPos() {
		return pathIndex == 0 ? navStart : path.get(pathIndex - 1).pos();
	}

	/** Walking, jumping up, dropping down, swimming and going through doors. */
	private void walk(LocalPlayer p, BlockPos node, NavPlanner.Move move) {
		double dx = node.getX() + 0.5 - p.getX();
		double dz = node.getZ() + 0.5 - p.getZ();
		double horiz = Math.sqrt(dx * dx + dz * dz);
		face(p, dx, dz);
		fwd = true;
		back = left = right = false;
		sprint = navSprint && move != NavPlanner.Move.SWIM && !p.isInWater();
		if (p.isInWater()) {
			// Stay at the surface, and get up onto the bank.
			navJump = node.getY() >= Math.floor(p.getY());
		} else if (node.getY() > p.getY() + 0.4) {
			jumpOnceTicks = Math.max(jumpOnceTicks, 1);
		}
		if (horiz < 0.55) advance(p);
	}

	/** Ladders and vines: jump held climbs, nothing held slides down. */
	private void climb(LocalPlayer p, BlockPos node, boolean up) {
		double dx = node.getX() + 0.5 - p.getX();
		double dz = node.getZ() + 0.5 - p.getZ();
		double horiz = Math.sqrt(dx * dx + dz * dz);
		if (horiz > 0.05) face(p, dx, dz);
		fwd = horiz > 0.25;
		back = left = right = false;
		sprint = false;
		navJump = up;
		boolean there = up ? p.getY() >= node.getY() - 0.05 : p.getY() <= node.getY() + 0.2;
		if (there && horiz < 0.6) {
			advance(p);
		} else {
			markProgress(p); // climbing straight up or down barely changes the distance to a far target
		}
	}

	/** Jump, and place a throwaway block where the feet were while the body is above it. */
	private void pillar(Minecraft mc, LocalPlayer p, BlockPos node) {
		ClientLevel level = mc.level;
		BlockPos base = node.below();
		holdStill(p);
		p.setXRot(90.0F);
		if (pillarPlaced) {
			if (level.getBlockState(base).canBeReplaced()) {
				pillarPlaced = false; // the server took it back: try again
			} else if (p.onGround() && p.getY() >= node.getY() - 0.05) {
				advance(p);
			} else if (stepTicks > PILLAR_TICKS + 40) {
				stopNavigationInternal("pillar_failed");
			}
			return;
		}
		if (!level.getBlockState(base).canBeReplaced()) {
			pillarPlaced = true; // something is there already
			return;
		}
		if (stepTicks > PILLAR_TICKS) {
			stopNavigationInternal("pillar_failed");
			return;
		}
		double dx = base.getX() + 0.5 - p.getX();
		double dz = base.getZ() + 0.5 - p.getZ();
		if (p.onGround() && Math.sqrt(dx * dx + dz * dz) > 0.3) {
			face(p, dx, dz); // get centred over the block first
			fwd = true;
			return;
		}
		int slot = throwawaySlot(p);
		if (slot < 0) {
			stopNavigationInternal("no_blocks");
			return;
		}
		selectSlot(p, slot);
		if (p.onGround()) {
			jumpOnceTicks = Math.max(jumpOnceTicks, 1);
		} else if (p.getY() > node.getY() + 0.02) {
			BlockPos against = base.below();
			BlockHitResult hit = new BlockHitResult(new Vec3(base.getX() + 0.5, base.getY(), base.getZ() + 0.5), Direction.UP, against, false);
			mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, hit);
			InteractHandlers.swingUse(p);
			pillarPlaced = true;
		}
		markProgress(p);
	}

	/**
	 * Mines the cells of a dig step one after another (each with the best hotbar tool), then waits a
	 * moment for falling blocks. Returns true once they are all open.
	 */
	private boolean clearCells(Minecraft mc, LocalPlayer p, NavPlanner.Step step) {
		if (navMining && miningPos != null) {
			holdStill(p);
			lookAt(p, miningPos);
			markProgress(p);
			return false;
		}
		if (navMiningResult != null) {
			String result = navMiningResult;
			navMiningResult = null;
			if (!"broken".equals(result)) {
				stopNavigationInternal("dig_failed");
				return false;
			}
		}
		ClientLevel level = mc.level;
		for (NavPos cell : step.dig()) {
			BlockPos pos = blockPos(cell);
			BlockState state = level.getBlockState(pos);
			if (open(level, pos, state)) continue;
			holdStill(p);
			settleTicks = 0;
			if (digsThisStep >= MAX_DIGS_PER_STEP) {
				stopNavigationInternal("dig_failed");
				return false;
			}
			if (!safeToDig(level, p, pos, state)) {
				stopNavigationInternal("unsafe_dig");
				return false;
			}
			selectSlot(p, bestTool(p, state));
			lookAt(p, pos);
			Direction face = InteractHandlers.faceToward(pos, p.getEyePosition());
			mc.gameMode.startDestroyBlock(pos, face);
			InteractHandlers.swingAttack(p);
			miningPos = pos;
			miningFace = face;
			miningTicks = 0;
			navMining = true;
			digsThisStep++;
			markProgress(p);
			return false;
		}
		if (digsThisStep > 0 && settleTicks++ < SETTLE_TICKS) {
			holdStill(p);
			markProgress(p);
			return false;
		}
		return true;
	}

	/** Open a closed wooden door or fence gate in the way (feet or head height). */
	private void openDoors(Minecraft mc, LocalPlayer p, BlockPos node) {
		if (doorCooldown > 0) return;
		for (BlockPos pos : new BlockPos[] {node, node.above()}) {
			BlockState s = mc.level.getBlockState(pos);
			if (!(s.is(BlockTags.WOODEN_DOORS) || s.is(BlockTags.FENCE_GATES))) continue;
			if (!s.hasProperty(BlockStateProperties.OPEN) || s.getValue(BlockStateProperties.OPEN)) return;
			if (!ClientMc.canReachBlock(p, pos, 1.0)) return;
			Direction face = InteractHandlers.faceToward(pos, p.getEyePosition());
			BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(pos), face, pos, false);
			mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, hit);
			InteractHandlers.swingUse(p);
			doorCooldown = 10;
			return;
		}
	}

	/** The cell is no obstacle for the body (the same rule as the planner's). */
	private static boolean open(ClientLevel level, BlockPos pos, BlockState s) {
		if (s.is(BlockTags.CLIMBABLE) || s.is(BlockTags.WOODEN_DOORS) || s.is(BlockTags.FENCE_GATES)) return true;
		VoxelShape shape = s.getCollisionShape(level, pos);
		return shape.isEmpty() || shape.max(Direction.Axis.Y) <= 0.2;
	}

	/** Re-checks the planner's digging rules against the world as it is now. */
	private static boolean safeToDig(ClientLevel level, LocalPlayer p, BlockPos pos, BlockState s) {
		if (pos.equals(p.blockPosition().below())) return false;
		if (s.getDestroySpeed(level, pos) < 0 || s.hasBlockEntity() || !s.getFluidState().isEmpty()) return false;
		for (Direction d : Direction.values()) {
			if (!level.getFluidState(pos.relative(d)).isEmpty()) return false;
		}
		return true;
	}

	private void advance(LocalPlayer p) {
		NavPlanner.Step done = path.get(pathIndex);
		if (done.move() == NavPlanner.Move.PILLAR || !done.dig().isEmpty()) p.setXRot(0.0F);
		pathIndex++;
		resetStep();
		markProgress(p);
	}

	private void resetStep() {
		stepTicks = 0;
		settleTicks = 0;
		digsThisStep = 0;
		pillarPlaced = false;
		navMiningResult = null;
	}

	/** Digging, placing or climbing is progress even when the distance to the target does not shrink. */
	private void markProgress(LocalPlayer p) {
		stuckTicks = 0;
		ticksWithoutProgress = 0;
		lastDist = p.position().distanceTo(Vec3.atBottomCenterOf(navTarget));
	}

	private void holdStill(LocalPlayer p) {
		fwd = back = left = right = false;
		sprint = false;
		navJump = p.isInWater();
	}

	private static void face(LocalPlayer p, double dx, double dz) {
		float yaw = (float) (Mth.atan2(dz, dx) * (180.0 / Math.PI)) - 90.0F;
		p.setYRot(yaw);
		p.setYHeadRot(yaw);
		p.setYBodyRot(yaw);
	}

	private static void lookAt(LocalPlayer p, BlockPos pos) {
		Vec3 eye = p.getEyePosition();
		double dx = pos.getX() + 0.5 - eye.x;
		double dy = pos.getY() + 0.5 - eye.y;
		double dz = pos.getZ() + 0.5 - eye.z;
		face(p, dx, dz);
		p.setXRot((float) -(Mth.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * (180.0 / Math.PI)));
	}

	/** Hotbar slot that breaks the block fastest, preferring one that gets its drops. */
	private static int bestTool(LocalPlayer p, BlockState state) {
		Inventory inv = p.getInventory();
		int best = selectedSlot(p);
		boolean requiresTool = state.requiresCorrectToolForDrops();
		boolean bestHarvests = !requiresTool || inv.getItem(best).isCorrectToolForDrops(state);
		float bestSpeed = inv.getItem(best).getDestroySpeed(state);
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = inv.getItem(slot);
			boolean harvests = !requiresTool || stack.isCorrectToolForDrops(state);
			float speed = stack.getDestroySpeed(state);
			if ((harvests && !bestHarvests) || (harvests == bestHarvests && speed > bestSpeed)) {
				best = slot;
				bestHarvests = harvests;
				bestSpeed = speed;
			}
		}
		return best;
	}

	private static int throwawaySlot(LocalPlayer p) {
		int selected = selectedSlot(p);
		if (LevelNavWorld.throwaway(p.getInventory().getItem(selected))) return selected;
		for (int slot = 0; slot < 9; slot++) {
			if (LevelNavWorld.throwaway(p.getInventory().getItem(slot))) return slot;
		}
		return -1;
	}

	private static int selectedSlot(LocalPlayer p) {
		//? if >=1.21.5 {
		return p.getInventory().getSelectedSlot();
		//?} else
		/*return p.getInventory().selected;*/
	}

	private static void selectSlot(LocalPlayer p, int slot) {
		//? if >=1.21.5 {
		p.getInventory().setSelectedSlot(slot);
		//?} else
		/*p.getInventory().selected = slot;*/
	}

	private static BlockPos blockPos(NavPos pos) {
		return new BlockPos(pos.x(), pos.y(), pos.z());
	}

	private void stopNavigationInternal(String reason) {
		path = null;
		navState = reason;
		fwd = false;
		sprint = false;
		navJump = false;
	}
}
