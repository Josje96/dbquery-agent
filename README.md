# DB Query Agent

Understand your data by asking questions in plain English. Review the SQL a model writes, then run it.

It's for anyone with a database and questions about it, including founders, startups, homelabbers and teams at work.

It's an early prototype. Login, saved queries, sharing and the SQL Server adapter aren't built yet, so it only runs on localhost for now. See [the model performance report](docs/findings.html) for accuracy and cost across 10 models.

## Setup

You need [Bun](https://bun.sh) and an API key for an OpenAI-compatible service. The defaults use [OpenRouter](https://openrouter.ai).

```bash
bun install
bun run setup:data      # downloads the test database, about 34 MB
cp .env.example .env    # then set MODEL_API_KEY in .env
bun run build
bun run start
```

Open http://127.0.0.1:3000. The server profiles the database in the background when it starts, which takes a few seconds.

To change models, follow the comments in `.env` and restart the server.

## How it works

1. **Profile, with no AI:** scripts record tables, keys, row counts and sample values in a local search index.
2. **Find tables, with no AI:** the question is searched against that index, and foreign keys connect the matches, so the model only sees relevant tables.
3. **Generate:** the model writes a `SELECT` using that schema and the notes in `notes/`.
4. **Check:** code refuses anything but a single read query, compiles it, and sends errors back to the model.
5. **Run on request:** the connection is read-only, with a row cap and a timeout.

Connections are defined in `connections.json`, and notes about each database go in `notes/`. Better notes usually mean better answers.

Only columns allowed by `sampleColumns` in `connections.json` have their values sampled, and sampled values are sent to the model provider. Zero data retention doesn't change that, so review this setting before connecting real data.

## Testing

```bash
bun test                     # needs no database, network or API key
bun run typecheck
bun run profile sqldex       # builds the profile that scoring reads
bun run eval sqldex <model>  # scores a model, using real paid API calls
```

Models that reject the temperature setting, such as Claude models and GPT-6 Luna, need `MODEL_TEMPERATURE=none`.

## Test data

`bun run setup:data` downloads `pokedex.sqlite` from [PokemonSQLTutorial](https://github.com/teamdandelion/PokemonSQLTutorial) at a pinned commit and verifies its checksum. That database was generated with [veekun/pokedex](https://github.com/veekun/pokedex).

The database isn't part of this repo. Pokémon data is the intellectual property of Nintendo, Creatures and GAME FREAK, and this project isn't affiliated with or endorsed by them. The source repo has no license of its own, so check that you're comfortable with your use of the data.

## License

The code in this repo is [MIT licensed](LICENSE). That doesn't cover the test database.
