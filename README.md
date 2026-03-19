# Tower Defense

Tower Defense game with AI auto-play.

Built with [ECS Game Factory](https://github.com/agadabanka/game-factory) using the **TypeScript Intermediate Language** pipeline.

## Architecture

```
game.js (TypeScript IL)  →  esbuild-wasm  →  standalone bundle
```

- `game.js` — The game spec written using the `@engine` SDK
- `demos/gameplay.gif` — AI gameplay demo

## Play

Visit [Game Factory](https://helloworld-production-c741.up.railway.app) to play this game in the browser.

## License

MIT
