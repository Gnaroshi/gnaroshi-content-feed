# Contract Fixtures

`npm run fixtures:build` deterministically creates valid and invalid schema-v1 feed fixtures. They cover bootstrap state, single-locale and paired writing, renamed translation slugs, multiple reading sessions, simple and rich reviews, implementation evidence, graph integrity, count mismatches, privacy leaks, dangling edges, and unhashed assets.

The generated fixture directories are committed so website and Studio CI can validate the same public contract without private source repositories.
