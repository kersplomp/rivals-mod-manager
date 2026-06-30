# Rivals Mod Manager

Hi! This is my mod manager for Marvel Rivals. I made it for myself, but if it works for you then great! You can file a bug report to this repo if it's not working for you. Thank you!

## How to use

1. Add your mod downloads folder (containing your raw mod archives or unzipped folders)
2. Set the game folder to the ~mods directory for Marvel Rivals
3. Add some mod lists and drag mods into them
4. Click apply to enable/disable your mod lists!

## How to develop

First:

1. Download [git](https://git-scm.com/), [rust](https://rust-lang.org/), [node.js](https://nodejs.org/en), and [7z](https://www.7-zip.org/).
2. Clone this repo
3. Run `npm install`

Then, after making changes, you can use this cheat sheet to build/test

```
npm test  # sanity check your changes
npx tauri dev    # run the app
npx tauri build  # build the exe
```

### Beginners Welcome

If you're not a coder, that's OK. You can use [ChatGPT or Codex CLI](https://openai.com/codex/) to guide you through this.
Please use GPT 5.5 or higher to get good results.

Feel free to use other models and tools like GLM 5.2 and OpenCode.
But I would personally avoid Claude, since unlike Codex CLI it is not open source!

If you're a newbie to coding, I'd avoid sending a PR until you've had more experience 🙏
If you're proud of something and want to share, submit a bug report with your prompt
instead of sending a PR.
