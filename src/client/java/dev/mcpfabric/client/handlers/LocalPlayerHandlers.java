package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientMc;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import org.jetbrains.annotations.Nullable;

/** Read-only state of the local player: position/vitals, inventory, equipment, effects. */
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
			o.addProperty("selectedSlot", p.getInventory().getSelectedSlot());
			o.addProperty("dimension", p.level().dimension().location().toString());
			var gm = ClientMc.mc().gameMode;
			o.addProperty("gameMode", gm != null ? gm.getPlayerMode().getName() : "unknown");
			return o;
		}));

		router.register("player.getInventory", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			Inventory inv = p.getInventory();
			var items = inv.getNonEquipmentItems(); // 0-8 hotbar, 9-35 main
			JsonObject o = new JsonObject();
			o.addProperty("selectedSlot", inv.getSelectedSlot());

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
