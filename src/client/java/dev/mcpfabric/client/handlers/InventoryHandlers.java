package dev.mcpfabric.client.handlers;

import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientMc;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.inventory.ClickType;

/** Inventory manipulation: hotbar selection, dropping a slot, swapping two slots. */
public final class InventoryHandlers {
	private InventoryHandlers() {}

	public static void register(RpcRouter router) {
		router.register("inventory.selectHotbar", ctx -> ClientMc.call(() -> {
			int slot = ctx.getInt("slot");
			if (slot < 0 || slot > 8) throw RpcException.badRequest("Hotbar slot must be 0-8.");
			LocalPlayer p = ClientMc.player();
			p.getInventory().setSelectedSlot(slot);
			p.connection.send(new ServerboundSetCarriedItemPacket(slot));
			return Json.ok("selected slot " + slot);
		}));

		router.register("inventory.dropSlot", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			MultiPlayerGameMode gm = ClientMc.gameMode();
			int menuSlot = toMenuSlot(ctx.getInt("slot"));
			boolean whole = ctx.optBool("wholeStack", true);
			gm.handleInventoryMouseClick(p.inventoryMenu.containerId, menuSlot, whole ? 1 : 0, ClickType.THROW, p);
			return Json.ok("dropped slot");
		}));

		router.register("inventory.swapSlots", ctx -> ClientMc.call(() -> {
			LocalPlayer p = ClientMc.player();
			MultiPlayerGameMode gm = ClientMc.gameMode();
			int a = toMenuSlot(ctx.getInt("slotA"));
			int b = toMenuSlot(ctx.getInt("slotB"));
			int id = p.inventoryMenu.containerId;
			gm.handleInventoryMouseClick(id, a, 0, ClickType.PICKUP, p);
			gm.handleInventoryMouseClick(id, b, 0, ClickType.PICKUP, p);
			gm.handleInventoryMouseClick(id, a, 0, ClickType.PICKUP, p);
			return Json.ok("swapped");
		}));
	}

	/**
	 * Map a player-inventory index to the slot index inside the player's {@code InventoryMenu}.
	 * Convention: 0-8 hotbar, 9-35 main, 36-39 armor (helmet..boots), 40 offhand.
	 */
	private static int toMenuSlot(int inv) throws RpcException {
		if (inv >= 0 && inv <= 8) return 36 + inv;       // hotbar -> menu 36-44
		if (inv >= 9 && inv <= 35) return inv;            // main -> menu 9-35
		if (inv >= 36 && inv <= 39) return 5 + (inv - 36); // armor -> menu 5-8 (helmet..boots)
		if (inv == 40) return 45;                         // offhand -> menu 45
		throw RpcException.badRequest("Inventory slot out of range (0-40): " + inv);
	}
}
