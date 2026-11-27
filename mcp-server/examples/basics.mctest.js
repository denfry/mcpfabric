// Examples for mcpfabric-test. They run server commands and clear the inventory, so use a test
// world and name it:  npx mcpfabric-test examples --world sp:TestWorld
// Needs an integrated or dedicated server with the mod (command()), enableCommands and
// enablePlayerControl in config/mcpfabric.config.json.

beforeEach(async () => {
  await command("clear @p", { allowFail: true }); // fails when the inventory is already empty
});

test("the player is in a world with no menu open", async () => {
  const screen = await mc.get_screen();
  expect(screen.inWorld).toBe(true);
  expect(screen.screen).toBe("none");
});

test("a broadcast reaches the client's chat", async () => {
  await command("say mctest ping");
  const line = await waitForChat("mctest ping");
  expect(line.text).toContain("mctest ping");
});

test("given items show up in the client's inventory", async ({ step }) => {
  await step("give a stack of torches", () => command("give @p minecraft:torch 64"));
  await step("the client has them", () => expect.poll(() => inventoryCount("torch"), { timeout: 5000 }).toBe(64));
});

test("a block placed by the server is there", async () => {
  const me = await mc.get_self();
  const at = { x: Math.floor(me.x) + 2, y: Math.floor(me.y), z: Math.floor(me.z) };
  await command(`setblock ${at.x} ${at.y} ${at.z} minecraft:gold_block`);
  const block = await mc.get_block(at);
  expect(block.id).toBe("minecraft:gold_block");
  await command(`setblock ${at.x} ${at.y} ${at.z} minecraft:air`);
});
