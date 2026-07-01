# Rivals Mod Manager

Hi! This is my mod manager for Marvel Rivals. I made it for myself, but if it works for you then great! You can file a bug report to this repo if it's not working for you. Thank you!

## How to use

1. Install [7z](https://www.7-zip.org/).
2. Click "Add Folder" and point it to your mod downloads folder containing mod archives or folders.
3. Set the game folder to the ~mods directory for Marvel Rivals
4. Add some mod lists and drag mods into them
5. Click apply to enable/disable your mod lists!

<img width="1911" height="1265" alt="image" src="https://github.com/user-attachments/assets/46e8f98e-8833-49aa-948b-85a41523472a" />


## How to develop

First:

1. Download [git](https://git-scm.com/), [rust](https://rust-lang.org/), [node.js](https://nodejs.org/en), and [7z](https://www.7-zip.org/).
2. Clone this repo
3. Run `npm install`

Then, after making changes, you can use this cheat sheet to build/test

```
npm test  # sanity check your changes
npm run dev    # run the app
npm run build  # build the exe and installer
```

### Beginners Welcome

If you're not a coder, that's OK. You can use [ChatGPT or Codex CLI](https://openai.com/codex/) to guide you through this.
Please use GPT 5.5 or higher to get good results.

Feel free to use other models and tools like GLM 5.2 and OpenCode.
But I would personally avoid Claude Code, since unlike Codex CLI and OpenCode it is not open source.
<!-- Also there are some Claude edgelords out there who harrass anyone that doesn't use Claude, and I don't like that. YMMV. -->

If you're a newbie to coding, I'd avoid sending a PR until you've had more experience 🙏
If you're proud of something and want to share, feel free to submit a bug report with your prompt
instead of sending a PR.
