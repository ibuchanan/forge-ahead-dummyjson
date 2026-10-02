import { $ } from "bun";

const version = (await $`git cliff --offline --bumped-version`.text())
  .trim()
  .replace(/^v/, "");

await $`bun pm version ${version} --no-git-tag-version`;
await $`git cliff --offline --tag v${version} --unreleased --prepend CHANGELOG.md`;

await $`git add package.json CHANGELOG.md`;
await $`git commit -m ${`chore(release): v${version}`}`;
await $`git tag v${version}`;
await $`git push origin main v${version}`;
