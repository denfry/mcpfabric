package dev.mcpfabric.client.fabric;

import dev.mcpfabric.client.AiControl;
import dev.mcpfabric.client.ClientEvents;
import dev.mcpfabric.client.McpFabricClient;
import net.fabricmc.api.ClientModInitializer;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;

/** Fabric client entrypoint: runs after {@code FabricEntrypoint} and wires client events. */
public class FabricClientEntrypoint implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		McpFabricClient.init();

		//? if <26.1 {
		net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper.registerKeyBinding(AiControl.TOGGLE_KEY);
		net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper.registerKeyBinding(AiControl.APPROVE_KEY);
		net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper.registerKeyBinding(AiControl.DENY_KEY);
		//?} else
		/*net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper.registerKeyMapping(AiControl.TOGGLE_KEY);
		net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper.registerKeyMapping(AiControl.APPROVE_KEY);
		net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper.registerKeyMapping(AiControl.DENY_KEY);*/
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> dispatcher.register(
				literal("mcpfabric")
						.executes(ctx -> { AiControl.status(); return 1; })
						.then(literal("stop").executes(ctx -> { AiControl.pause(); return 1; }))
						.then(literal("resume").executes(ctx -> { AiControl.resume(); return 1; }))
						.then(literal("status").executes(ctx -> { AiControl.status(); return 1; }))
						.then(answer("approve", true))
						.then(answer("deny", false))));

		ClientTickEvents.END_CLIENT_TICK.register(McpFabricClient::onClientTick);
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> McpFabricClient.onClientStopping());
		ClientReceiveMessageEvents.GAME.register(ClientEvents::onSystemMessage);
		ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTimestamp) -> {
			String name = null;
			if (sender != null) {
				//? if <1.21.9 {
				name = sender.getName();
				//?} else
				/*name = sender.name();*/
			}
			ClientEvents.onChatMessage(message, name);
		});
	}

	/** {@code approve [id]} / {@code deny [id]}: without an id, the oldest request. */
	private static LiteralArgumentBuilder<FabricClientCommandSource> answer(String name, boolean approve) {
		return literal(name)
				.executes(ctx -> { AiControl.answer(0, approve); return 1; })
				.then(RequiredArgumentBuilder.<FabricClientCommandSource, Integer>argument("id", IntegerArgumentType.integer(1))
						.executes(ctx -> { AiControl.answer(IntegerArgumentType.getInteger(ctx, "id"), approve); return 1; }));
	}

	/** Brigadier's own builder: Fabric renamed its helper (ClientCommandManager, ClientCommands) in 26.1. */
	private static LiteralArgumentBuilder<FabricClientCommandSource> literal(String name) {
		return LiteralArgumentBuilder.literal(name);
	}
}
