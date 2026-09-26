package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.handlers.support.Levels;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.TooltipFlag;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import org.jetbrains.annotations.Nullable;

/** Read-only state of the local player: position/vitals, inventory, tooltips, crosshair target, effects. */
public final class LocalPlayerHandlers {
	private LocalPlayerHandlers() {}

	public static void register(RpcRouter router) {
		router.register("player.getState", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			JsonObject o = new JsonObject();
			o.addProperty("x", p.getX());
			o.addProperty("y", p.getY());
			o.addProperty("z", p.getZ());
			o.addProperty("yaw", p.getYRot());
			o.addProperty("pitch", p.getXRot());
			JsonObject motion = new JsonObject();
			motion.addProperty("x", p.getDeltaMovement().x);
			motion.addProperty("y", p.getDeltaMovement().y);
			motion.addProperty("z", p.getDeltaMovement().z);
			o.add("motion", motion);
			o.addProperty("health", p.getHealth());
			o.addProperty("maxHealth", p.getMaxHealth());
			o.addProperty("food", p.getFoodData().getFoodLevel());
			o.addProperty("saturation", p.getFoodData().getSaturationLevel());
			o.addProperty("air", p.getAirSupply());
			o.addProperty("maxAir", p.getMaxAirSupply());
			o.addProperty("xpLevel", p.experienceLevel);
			o.addProperty("xpProgress", p.experienceProgress);
			o.addProperty("onGround", p.onGround());
			o.addProperty("inWater", p.isInWater());
			o.addProperty("sprinting", p.isSprinting());
			o.addProperty("sneaking", p.isShiftKeyDown());
			o.addProperty("usingItem", p.isUsingItem());
			o.addProperty("selectedSlot", selectedSlot(p.getInventory()));
			//? if <1.21.11 {
				o.addProperty("dimension", p.level().dimension().location().toString());
				//?} else
				/*o.addProperty("dimension", p.level().dimension().identifier().toString());*/
			var gm = ClientMc.mc().gameMode;
			o.addProperty("gameMode", gm != null ? gm.getPlayerMode().getName() : "unknown");
			return o;
		}));

		router.register("player.getInventory", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			Inventory inv = p.getInventory();
			//? if >=1.21.5 {
			var items = inv.getNonEquipmentItems(); // 0-8 hotbar, 9-35 main
			//?} else
			/*var items = inv.items;*/
			JsonObject o = new JsonObject();
			o.addProperty("selectedSlot", selectedSlot(inv));

			JsonArray hotbar = new JsonArray();
			for (int i = 0; i <= 8 && i < items.size(); i++) addItem(hotbar, i, items.get(i));
			o.add("hotbar", hotbar);

			JsonArray main = new JsonArray();
			for (int i = 9; i <= 35 && i < items.size(); i++) addItem(main, i, items.get(i));
			o.add("main", main);

			JsonArray armor = new JsonArray();
			for (EquipmentSlot slot : new EquipmentSlot[]{EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET}) {
				ItemStack st = p.getItemBySlot(slot);
				if (!st.isEmpty()) {
					JsonObject j = itemJson(st);
					j.addProperty("slot", slot.getName());
					armor.add(j);
				}
			}
			o.add("armor", armor);
			o.add("offhand", itemJson(p.getOffhandItem()));
			return o;
		}));

		router.register("player.getEquipment", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			JsonObject o = new JsonObject();
			o.add("mainHand", itemJson(p.getMainHandItem()));
			o.add("offHand", itemJson(p.getOffhandItem()));
			o.add("helmet", itemJson(p.getItemBySlot(EquipmentSlot.HEAD)));
			o.add("chest", itemJson(p.getItemBySlot(EquipmentSlot.CHEST)));
			o.add("legs", itemJson(p.getItemBySlot(EquipmentSlot.LEGS)));
			o.add("boots", itemJson(p.getItemBySlot(EquipmentSlot.FEET)));
			return o;
		}));

		router.register("player.getTooltip", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			ItemStack stack;
			if (ctx.has("menuSlot")) {
				// The open container's menu (the player's own inventory menu when no screen is open).
				AbstractContainerMenu menu = p.containerMenu;
				int i = ctx.getInt("menuSlot");
				if (i < 0 || i >= menu.slots.size()) throw RpcException.badRequest("menuSlot out of range (0-" + (menu.slots.size() - 1) + ").");
				stack = menu.slots.get(i).getItem();
			} else {
				stack = inventoryItem(p, ctx.optInt("slot", selectedSlot(p.getInventory())));
			}
			JsonObject o = itemJson(stack);
			JsonArray lines = new JsonArray();
			if (!stack.isEmpty()) {
				TooltipFlag flag = ctx.optBool("advanced", false) ? TooltipFlag.ADVANCED : TooltipFlag.NORMAL;
				for (Component line : stack.getTooltipLines(Item.TooltipContext.of(p.level()), p, flag)) {
					lines.add(line.getString());
				}
			}
			o.add("lines", lines);
			return o;
		}));

		router.register("player.getTarget", ctx -> ClientMc.call(() -> {
			Minecraft mc = ClientMc.mc();
			LocalPlayer p = ClientMc.player();
			HitResult hit = mc.hitResult;
			JsonObject o = new JsonObject();
			if (hit instanceof BlockHitResult bhr && hit.getType() == HitResult.Type.BLOCK) {
				BlockPos pos = bhr.getBlockPos();
				o.addProperty("type", "block");
				o.add("block", Levels.describeBlock(p.level(), pos, p.level().getBlockState(pos)));
				o.addProperty("face", bhr.getDirection().getName());
			} else if (hit instanceof EntityHitResult ehr) {
				Entity e = ehr.getEntity();
				o.addProperty("type", "entity");
				o.addProperty("uuid", e.getUUID().toString());
				o.addProperty("entityType", BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
				o.addProperty("name", e.getName().getString());
				o.add("pos", vec(e.position()));
			} else {
				o.addProperty("type", "none");
				return o;
			}
			o.add("hit", vec(hit.getLocation()));
			o.addProperty("distance", p.getEyePosition().distanceTo(hit.getLocation()));
			return o;
		}));

		router.register("player.getStatusEffects", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			JsonArray effects = new JsonArray();
			for (MobEffectInstance inst : p.getActiveEffects()) {
				JsonObject e = new JsonObject();
				e.addProperty("id", BuiltInRegistries.MOB_EFFECT.getKey(inst.getEffect().value()).toString());
				e.addProperty("amplifier", inst.getAmplifier());
				e.addProperty("durationTicks", inst.getDuration());
				e.addProperty("ambient", inst.isAmbient());
				e.addProperty("visible", inst.isVisible());
				effects.add(e);
			}
			JsonObject o = new JsonObject();
			o.add("effects", effects);
			return o;
		}));
	}

	/** The selected hotbar slot. The accessor replaced the public {@code selected} field in 1.21.5. */
	private static int selectedSlot(Inventory inv) {
		//? if >=1.21.5 {
		return inv.getSelectedSlot();
		//?} else
		/*return inv.selected;*/
	}

	/**
	 * A player inventory slot in this API's numbering: 0-8 hotbar, 9-35 main, 36-39 armor from helmet
	 * to boots, 40 offhand.
	 */
	private static ItemStack inventoryItem(LocalPlayer p, int slot) throws RpcException {
		if (slot >= 0 && slot <= 35) return p.getInventory().getItem(slot);
		return switch (slot) {
			case 36 -> p.getItemBySlot(EquipmentSlot.HEAD);
			case 37 -> p.getItemBySlot(EquipmentSlot.CHEST);
			case 38 -> p.getItemBySlot(EquipmentSlot.LEGS);
			case 39 -> p.getItemBySlot(EquipmentSlot.FEET);
			case 40 -> p.getOffhandItem();
			default -> throw RpcException.badRequest("Inventory slot out of range (0-40): " + slot);
		};
	}

	private static JsonObject vec(Vec3 v) {
		JsonObject o = new JsonObject();
		o.addProperty("x", v.x);
		o.addProperty("y", v.y);
		o.addProperty("z", v.z);
		return o;
	}

	private static void addItem(JsonArray arr, int slot, ItemStack stack) {
		if (stack.isEmpty()) return;
		JsonObject o = itemJson(stack);
		o.addProperty("slot", slot);
		arr.add(o);
	}

	@Nullable
	private static JsonObject itemJson(ItemStack stack) {
		JsonObject o = new JsonObject();
		if (stack.isEmpty()) {
			o.addProperty("empty", true);
			return o;
		}
		o.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
		o.addProperty("count", stack.getCount());
		o.addProperty("name", stack.getHoverName().getString());
		if (stack.isDamageableItem()) {
			o.addProperty("damage", stack.getDamageValue());
			o.addProperty("maxDamage", stack.getMaxDamage());
		}
		return o;
	}
}
