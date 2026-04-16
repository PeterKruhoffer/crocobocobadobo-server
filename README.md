# crocobocobadobo server

## How to run:
```bash
pnpm install
pnpm run dev
```


# About this project
This is the server that fetches a CSGO match log and parses it into a JSON structure that can be consumed on the [client](https://github.com/PeterKruhoffer/crocobocobadobo-client)

I have never built a parser of any kind before, so this was a fun challenge

## Choices made
I have gone pretty bare bones with dependencies. I would probably have used Zod and Drizzle for the early version.
Zod for validating shape on the edges of the program. Drizzle for the DB things, although it's only a small amount of SQL currently I have already messed it up 2 times (haha)

If I were to make this into a full on match log parser, I would research parsers and the logs to get a better understanding of how to build it.
I would also look into if something like Effect or better-result could help with structure and consistency, traces, spans etc.

## AI
Since I have never made a parser before I had AI build a PoC to have some sort of starting point, it worked but the code was just 1 big function.
I read through the "example code" to get an understanding and then started writing my own version

Once the overall structure was in place and there was a lot of code the AI could base its work on ,I could start using the AI for tasks like "parse how many molotovs have been thrown in the match"

I also used AI to work with me on a [refactoring plan](./refactor.md) for the project and once it was in place (the plan) I could step by step have the AI implement it.
It's by no means perfect and in the future I would spend more time on my own, thinking about a structure for the project, I would still let the AI implement it piece by piece.

## Final thoughts
This was a really fun and challenging project, I have never made a parser before (as you can probably tell).
Next time I make a parser I will have a better idea of what to do, or at least an easier time getting started.
