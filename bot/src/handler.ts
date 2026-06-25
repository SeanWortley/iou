export async function handleBotMessage(ctx: any): Promise<void> {
  const msg = ctx.message as any;
  if (!msg || !msg.text) return;

  let text = msg.text;
  const entities = msg.entities ?? [];
  const commandEntity = entities.find((e: any) => e.type === "bot_command");
  const command = commandEntity
    ? text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length)
    : "";

  if (command) {
    switch (command) {
      case "/start":
      case "/iou":
        await ctx.reply("Hello — welcome to OpenRemit bot. Use /iou to create an IOU.");
        return;
      default:
        await ctx.reply(`Unknown command: ${command}`);
        return;
    }
  }

  // Fallback: echo the received text
  await ctx.reply(text);
}
