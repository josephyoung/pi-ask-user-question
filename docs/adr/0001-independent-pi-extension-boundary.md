# Build and test the extension independently in Pi

The project implements, builds, and tests `ask_user_question` as an independent Pi Coding Agent extension without importing or executing Dano. Its initial model-facing parameter schema remains exactly the same as Dano's current `ask_user_question` schema; that schema is implemented and verified inside this repository through Pi Coding Agent. Dano-specific adapters and migration work remain outside this project.
