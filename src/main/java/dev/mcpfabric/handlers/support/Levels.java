package dev.mcpfabric.handlers.support;

import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
//? if <1.21.11 {
import net.minecraft.resources.ResourceLocation;
//?} else
/*import net.minecraft.resources.Identifier;*/
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import org.jetbrains.annotations.Nullable;

import java.util.Map;

/** Helpers for resolving dimensions and describing blocks. */
public final class Levels {
	private Levels() {}

	public static ServerLevel resolve(MinecraftServer server, @Nullable String dimension) throws RpcException {
		if (dimension == null || dimension.isBlank()) {
			return server.overworld();
		}
		//? if <1.21.11 {
		ResourceLocation id = ResourceLocation.tryParse(dimension);
		//?} else
		/*Identifier id = Identifier.tryParse(dimension);*/
		if (id == null) {
			throw RpcException.badRequest("Invalid dimension id: " + dimension);
		}
		ResourceKey<Level> key = ResourceKey.create(Registries.DIMENSION, id);
		ServerLevel level = server.getLevel(key);
		if (level == null) {
			throw RpcException.notFound("No such dimension: " + dimension);
		}
		return level;
	}

	public static String dimensionId(Level level) {
		//? if <1.21.11 {
		return level.dimension().location().toString();
		//?} else
		/*return level.dimension().identifier().toString();*/
	}

	/** World spawn position. {@code getSharedSpawnPos()} became {@code getRespawnData().pos()} in 1.21.9. */
	public static BlockPos spawnPos(ServerLevel level) {
		//? if <1.21.9 {
		return level.getSharedSpawnPos();
		//?} else
		/*return level.getRespawnData().pos();*/
	}

	/** World day-time in ticks. {@code getDayTime()} became {@code getDefaultClockTime()} in 26.1. */
	public static long dayTime(ServerLevel level) {
		//? if <26.1 {
		return level.getDayTime();
		//?} else
		/*return level.getDefaultClockTime();*/
	}

	public static String blockId(BlockState state) {
		return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	private static String propertyValue(Property property, Comparable value) {
		return property.getName(value);
	}

	public static JsonObject describeBlock(Level level, BlockPos pos, BlockState state) {
		JsonObject o = new JsonObject();
		o.addProperty("x", pos.getX());
		o.addProperty("y", pos.getY());
		o.addProperty("z", pos.getZ());
		o.addProperty("id", blockId(state));
		o.addProperty("air", state.isAir());
		o.addProperty("liquid", !state.getFluidState().isEmpty());

		//? if <26.1 {
		Map<Property<?>, Comparable<?>> values = state.getValues();
		if (!values.isEmpty()) {
			JsonObject props = new JsonObject();
			for (Map.Entry<Property<?>, Comparable<?>> e : values.entrySet()) {
				props.addProperty(e.getKey().getName(), propertyValue(e.getKey(), e.getValue()));
			}
			o.add("properties", props);
		}
		//?} else {
		/*JsonObject props = new JsonObject();
		state.getValues().forEach(v -> props.addProperty(v.property().getName(), v.valueName()));
		if (props.size() > 0) o.add("properties", props);
		*///?}
		return o;
	}
}
