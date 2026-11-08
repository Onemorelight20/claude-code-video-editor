"use strict";
// Interface language: Ukrainian (source) or English. Loaded before app.js.
// gettext style: the Ukrainian source string is the key; EN maps it to English. A missing key falls back to
// Ukrainian. Never pass user data through t(): captions, notes, Claude's replies, shot and footage notes stay as written.
//   t("Нових вказівок: {n}.", {n})                  -> fills {name} placeholders
//   tn(n, "{n} кадр", "{n} кадри", "{n} кадрів")    -> Ukrainian 1 / 2-4 / 5+ form; EN keeps [singular, plural] under the last key
//   translateDom(root)                              -> static HTML: text nodes + title / placeholder / aria-label
const langStore = {  // same try/catch as app.js `store` (that one is declared later)
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
};
// stored choice; else Ukrainian for an existing user (has a remembered episode) or a uk browser; else English
const LANG = (() => {
  const v = langStore.get("lang");
  if (v === "uk" || v === "en") return v;
  if (langStore.get("ep") != null) return "uk";
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
  return langs.some((l) => /^uk(-|_|$)/i.test(l || "")) ? "uk" : "en";
})();
document.documentElement.lang = LANG;

const EN = {

  // ---------- «Монтаж» (Edit) tab, apply effects, main version
  "Змінити монтаж без Claude: порядок, швидкість, звук, кадрування": "Change the edit without Claude: order, speed, sound, crop",
  "Зробити основною": "Make main",
  "Цю версію UI відкриватиме за замовчуванням": "Open this version by default",
  "Застосувати до відео": "Apply to the video",
  "Записати ці ефекти в монтаж; у відео — після «Зробити версію»": "Write these effects into the edit; they show up in the video after “Render version”",
  "Прибрати ефекти з відео": "Remove effects from the video",
  "застосовую…": "applying…",
  "✓ Застосовано{fx}. У відео — після «Зробити версію».": "✓ Applied{fx}. In the video after “Render version”.",
  "не вийшло": "didn't work",
  "Скасовано": "Undone",
  "Повторено": "Redone",
  "Порядок змінено": "Order changed",
  "Кадр прибрано. Скасувати — ⌘Z": "Shot removed. Undo: ⌘Z",
  "таймлапс ×{s}": "timelapse ×{s}",
  "сповільнено {s}×": "slowed to {s}×",
  "без звуку": "muted",
  "звук {n}%": "sound {n}%",
  "кроп ×{z}": "crop ×{z}",
  "наїзд": "push-in",
  "Чернетка монтажу": "Draft edit",
  "є зміни, яких ще немає у відео": "has changes that are not in the video yet",
  "Програти чернетку з початку: кадри з матеріалу з кропом і швидкістю, без рендеру (без звуку)": "Play the draft from the start: shots from the footage with crop and speed, without rendering (no sound)",
  "Переглянути чернетку": "Preview draft",
  "Зміни одразу йдуть у монтаж, у відео — після «Зробити версію». Тягни кадр за ⋮⋮, щоб змінити порядок.": "Changes go into the edit right away and show up in the video after “Render version”. Drag a shot by ⋮⋮ to reorder.",
  "Скасувати: {w} (⌘Z)": "Undo: {w} (⌘Z)",
  "Монтаж змінено поза інтерфейсом (наприклад, Claude) — скасувати нема чого": "The edit was changed outside the UI (by Claude, for example), so there is nothing to undo",
  "Нема чого скасувати": "Nothing to undo",
  "Повторити: {w} (⇧⌘Z)": "Redo: {w} (⇧⌘Z)",
  "Нема чого повторити": "Nothing to redo",
  "Перетягни, щоб змінити порядок": "Drag to reorder",
  "Подивитись цей кадр": "Preview this shot",
  "Назва": "Name",
  "Увімкнути звук": "Unmute",
  "Вимкнути звук": "Mute",
  "Кадрування": "Crop",
  "Тягни, щоб вибрати частину кадру": "Drag to choose part of the frame",
  "Наблизь повзунком і тягни рамку на мініатюрі, щоб вибрати частину кадру.": "Zoom in with the slider and drag the frame on the thumbnail to choose part of the picture.",
  "Увесь кадр": "Full frame",
  "Підрізати": "Trim",
  "На одне місце раніше": "Move one earlier",
  "На одне місце пізніше": "Move one later",
  "Прибрати": "Remove",
  "Сповільнити вдвічі (плавно, з домальованими кадрами)": "Half speed (smooth, with interpolated frames)",
  "Звичайна швидкість": "Normal speed",
  "Трохи швидше": "A bit faster",
  "Удвічі швидше": "Twice as fast",
  "Таймлапс ×8: початок і кінець дії звичайні, середина швидко": "Timelapse ×8: the start and end of the action at normal speed, the middle fast",
  "Таймлапс ×20 — для довгих одноманітних дій з нерухомої камери": "Timelapse ×20: for long repetitive actions from a static camera",
  "Цього кадру ще немає у відео: зроби версію, щоб підрізати його в редакторі.": "This shot is not in the video yet: render a version to trim it in the clip editor.",
  "Вибери шматок (можна з іншого кліпу ліворуч) і натисни «Додати у відео»: він стане після кадру #{n}.": "Pick a range (from another clip on the left if you like) and press “Add to video”: it goes after shot #{n}.",
  "Чернетка · кадр {n} з {m} · клік — зупинити": "Draft · shot {n} of {m} · click to stop",
  "«{n}»: змінено швидкість, звук чи кадрування": "“{n}”: speed, sound or crop changed",
  "Ефекти змінено": "Effects changed",
  // ---------- page, header, banner
  "Монтаж": "Editing",   // page title before an episode loads, and «Монтаж» in the keys window
  "Показати / сховати матеріал (M)": "Show / hide footage (M)",
  "Відео": "Video",
  "Версія монтажу. Клавіша V — перемкнути на попередню переглянуту (той самий момент)":
    "Edit version. V switches to the previously viewed one (same moment)",
  "Відкрита не основна версія. Клік — повернутись до основної": "This is not the main version. Click to go back to the main one",
  "Нова версія з поточним світлом, написами й переходами (монтаж той самий)":
    "New version with the current light, captions and transitions (same edit)",
  "Зробити версію": "Render version",
  "Завантажити цю версію": "Download this version",
  "Завантажити": "Download",
  "Клавіші й підказки (?)": "Keys and tips (?)",
  "Мова інтерфейсу": "Interface language",
  "Готова нова версія": "New version ready:",
  "Показати": "Show",
  "Закрити": "Close",
  "файл": "file",
  "✓ основна": "✓ main",
  "не основна · до {v}": "not main · back to {v}",
  "ще немає рендерів": "no renders yet",
  "Версія монтажу": "Edit version",
  "Що змінилось: {note}\n\nКлавіша V — попередня переглянута версія": "What changed: {note}\n\nV: previously viewed version",
  "натуральний": "natural",
  "теплий вечір": "warm evening",
  "плівка": "film",
  "світлий кремовий": "light cream",
  "с": "s",
  "{n}с": "{n}s",
  "МБ": "MB",

  // ---------- welcome screen (no episodes yet)
  "Ще немає жодного відео": "No videos yet",
  "Створи перше: поклади кліпи в теку або zip і запусти в терміналі, у теці проєкту:":
    "Create the first one: put your clips in a folder or a zip and run this in a terminal, in the project folder:",
  "Потім онови цю сторінку й попроси Claude Code в чаті:": "Then reload this page and ask Claude Code in chat:",
  "Змонтуй епізод 2026-03-14-pancakes: до хвилини, готова страва як хук, далі кроки рецепта.":
    "Cut the episode 2026-03-14-pancakes: under a minute, the finished dish as the hook, then the recipe steps.",
  "Відзнятий матеріал лишається на твоєму комп'ютері. Докладніше — README.md і docs/ui.md.":
    "Your footage stays on your computer. More in README.md and docs/ui.md.",
  "Оновити": "Reload",

  // ---------- footage panel
  "Матеріал": "Footage",
  "{n} кліпів": ["{n} clip", "{n} clips"],
  "Сховати панель (M)": "Hide panel (M)",
  "Пошук: крем, IMG_0123…": "Search: cream, IMG_0123…",
  "Шукає в назвах кліпів, нотатках і етапах. Наведи на кліп, щоб гортати; клік відкриває редактор уривка.":
    "Searches clip names, notes and stages. Hover a clip to scrub through it; click opens the clip editor.",
  "лише ті, що не в монтажі": "only clips not in the edit",
  "Без етапу": "No stage",
  "Нічого не знайдено за «{q}».": "Nothing found for “{q}”.",
  "Нічого не знайдено.": "Nothing found.",

  // ---------- player
  "ефекти · прев'ю": "effects · preview",
  "світло · прев'ю": "light · preview",
  "прев'ю переходу · клік — закрити": "transition preview · click to close",
  "Грати (Пробіл)": "Play (Space)",
  "Перетягни, щоб перемотати": "Drag to seek",
  "Дивитись з початку (Home)": "Play from the start (Home)",
  "Пауза / грати (Пробіл)": "Pause / play (Space)",
  "На 1/30 с назад (←) · ⇧← попередній кадр монтажу": "1/30 s back (←) · ⇧← previous shot",
  "На 1/30 с вперед (→) · ⇧→ наступний кадр монтажу": "1/30 s forward (→) · ⇧→ next shot",
  "Швидкість": "Speed",
  "Звук": "Sound",
  "Повтор": "Loop",
  "На весь екран (F)": "Full screen (F)",

  // ---------- side tabs
  "Вказівки": "Notes",
  "Кадри": "Shots",
  "Світло": "Light",
  "Текст": "Captions",
  "Переходи": "Transitions",
  "Ефекти": "Effects",

  // ---------- notes tab: current shot, compose, list
  "Скопіювати фразу для чату": "Copy the phrase for the chat",
  "Копіювати": "Copy",
  "Скопійовано": "Copied",
  "не вдалося": "failed",
  "внеси правки": "apply my notes",
  "Нових вказівок: <b>{n}</b>. Напиши Claude в чаті «внеси правки».": "New notes: <b>{n}</b>. Tell Claude in chat “apply my notes”.",
  "Відкрити цей кадр у редакторі уривка й посунути межі": "Open this shot in the clip editor and move its edges",
  "Підрізати кадр": "Trim shot",
  "Інші варіанти цього кадру з матеріалу (вкладка «Кадри»)": "Other takes for this shot from the footage (“Shots” tab)",
  "Варіанти": "Alternatives",
  "увесь кліп →": "whole clip →",
  "Для цього файлу немає таймлайну": "No timeline for this file",
  " · прискорення до {x}× у середині": " · speeds up to {x}× in the middle",
  " · швидкість {x}×": " · speed {x}×",
  "{a}–{b} с у відео · джерело {clip}, {i}–{o} с": "{a}–{b} s in the video · source {clip}, {i}–{o} s",
  "Прив'язка:": "Pin to:",
  "кадр": "shot",
  "момент": "moment",
  "все відео": "whole video",
  "Що змінити? Напр.: «зроби довше», «візьми момент, де ложка посередині», «заміни на IMG_0123»… Enter — додати, Shift+Enter — новий рядок":
    "What to change? E.g. “make it longer”, “take the moment with the spoon in the middle”, “replace with IMG_0123”… Enter adds, Shift+Enter for a new line",
  "прибрати": "remove",
  "довше": "longer",
  "коротше": "shorter",
  "інший момент цього кліпу": "another moment of this clip",
  "замінити кадр": "replace the shot",
  "додати кадр після": "add a shot after",
  "поміняти порядок": "change the order",
  "наблизити": "zoom in",
  "подобається ✓": "like it ✓",
  "Додати вказівку (Enter)": "Add note (Enter)",
  "зберігаю…": "saving…",
  "помилка: {e}": "error: {e}",
  "додано ✓": "added ✓",
  "Виконані в останній версії видно завжди": "Notes done in the latest version are always shown",
  "усі виконані": "show all done",
  "усі виконані (ще {n})": "show all done ({n} more)",
  "Залиш вказівки й напиши Claude в чаті:": "Leave notes and tell Claude in chat:",
  "«внеси правки»": "“apply my notes”",
  ". Він їх застосує, зробить нову версію, і тут з'являться його відповіді.": ". Claude applies them, renders a new version, and the replies show up here.",
  "нова": "new",
  "питання": "question",
  "виконано": "done",
  "нових {a} · питань {n} · виконано {c}": ["{a} new · {n} question · {c} done", "{a} new · {n} questions · {c} done"],
  "{a} нових, {n} з питанням": ["{a} new, {n} with a question", "{a} new, {n} with questions"],
  "· з чату": "· from chat",
  "✎ редагувати": "✎ edit",
  "не так, переробити": "not right, redo",
  "відповісти": "reply",
  "Подвійний клік — редагувати": "Double-click to edit",
  "видалити": "delete",
  "точно видалити?": "really delete?",
  "Поки що вказівок немає. Постав відео на паузу на потрібному кадрі й напиши, що змінити.":
    "No notes yet. Pause the video on the shot you want and write what to change.",
  "зберегти (Enter)": "save (Enter)",
  "скасувати (Esc)": "cancel (Esc)",
  "\n— ": "\n- ",   // start of the answer to Claude's question in the edit box

  // ---------- timeline
  "Таймлайн": "Timeline",
  "Що позначено над кадрами": "What the marks above the shots mean",
  "вказівка": "note",
  "напис": "caption",
  "перехід": "transition",
  "клік — перемотати · ✎ або подвійний клік — змінити уривок": "click to seek · ✎ or double-click to change the range",
  "Масштаб таймлайну": "Timeline zoom",
  "Дрібніше (−)": "Zoom out (−)",
  "Усе відео в ширину (0)": "Fit the whole video (0)",
  "Вмістити": "Fit",
  "Крупніше (+)": "Zoom in (+)",
  "Для цього файлу немає таймлайну (його рендерили без опису версії).": "No timeline for this file (it was rendered without a version description).",
  "{n} кадрів": ["{n} shot", "{n} shots"],
  "{a}–{b} с · {clip} {i}–{o} с": "{a}–{b} s · {clip} {i}–{o} s",
  "✎ або подвійний клік — підрізати кадр": "✎ or double-click to trim the shot",

  // ---------- keys modal
  "Клавіші й підказки": "Keys and tips",
  "Закрити (Esc)": "Close (Esc)",
  "Перегляд": "Playback",
  "Пробіл": "Space",
  "грати / пауза": "play / pause",
  "на 1/30 с назад / вперед": "1/30 s back / forward",
  "попередній / наступний кадр монтажу": "previous / next shot",
  "з початку": "from the start",
  "на весь екран": "full screen",
  "попередня переглянута версія (той самий момент)": "previously viewed version (same moment)",
  "(утримувати)": "(hold)",
  "як було без змін світла чи ефектів": "as it was, without light or effect changes",
  "або": "or",
  "написати вказівку": "write a note",
  "масштаб таймлайну / вмістити": "timeline zoom / fit",
  "показати / сховати матеріал": "show / hide footage",
  "✎ на кадрі": "✎ on a shot",
  "змінити уривок кадру (або подвійний клік)": "change the shot's range (or double-click)",
  "закрити вікно, вийти з поля": "close a window, leave a field",
  "Редактор уривка": "Clip editor",
  "початок / кінець шматка тут": "range start / end here",
  "масштаб смужки, до вибраного, увесь кліп": "strip zoom, zoom to selection, whole clip",
  "коліщатко": "scroll wheel",
  "масштаб смужки; рух убік — гортати": "strip zoom; sideways to scroll",
  "Як працює": "How it works",
  "Залиш вказівки (або зміни кадри, світло, написи, переходи) і напиши Claude в чаті":
    "Leave notes (or change shots, light, captions, transitions) and tell Claude in chat",
  ". Свої зміни світла, написів і переходів можна зробити версією самостійно:":
    ". You can render your own light, caption and transition changes into a version yourself:",
  "«Зробити версію»": "“Render version”",
  ". Крапка біля кнопки означає, що є зміни, яких ще немає у файлі.": ". A mark on the button means there are changes that are not in the file yet.",

  // ---------- clip editor
  "Інший кліп: крем, кава, IMG_0123…": "Another clip: cream, coffee, IMG_0123…",
  "не в монтажі": "not in the edit",
  "Вибрати шматок для відео": "Pick a range for the video",
  "Увесь кліп. Рамка — частина, яку видно на смужці: тягни, щоб гортати, клік — перейти туди":
    "The whole clip. The frame is the part shown on the strip: drag to scroll, click to jump there",
  "Показати вибраний шматок крупно (Z)": "Zoom to the selected range (Z)",
  "До вибраного": "Zoom to selection",
  "Увесь кліп (0)": "Whole clip (0)",
  "Увесь кліп": "Whole clip",
  "Початок шматка = поточний кадр (I)": "Range start = current frame (I)",
  "[ Початок тут": "[ Start here",
  "Кінець шматка = поточний кадр (O)": "Range end = current frame (O)",
  "Кінець тут ]": "End here ]",
  "Програти вибраний шматок по колу": "Loop the selected range",
  "Вибране": "Selection",
  "Вставити після": "Insert after",
  "Замінити кадр": "Replace shot",
  "＋ Додати у відео": "＋ Add to video",
  "✓ Замінити кадр": "✓ Replace shot",
  "Згадати у вказівці": "Mention in a note",
  "Перетягни рамку на смужці або постав межі кнопками. Коліщатко чи щипок на смужці — масштаб, рух убік — гортати; довгі кліпи відкриваються вже наближеними. «Додати у відео» вносить шматок у монтаж, і він з'явиться після «Зробити версію». «Згадати у вказівці» вставить у текст":
    "Drag the selection on the strip or set its edges with the buttons. Scroll or pinch on the strip to zoom, sideways to scroll; long clips open already zoomed in. “Add to video” puts the range into the edit, and it shows up after “Render version”. “Mention in a note” inserts",
  "[IMG_0123 4.20–5.60 с]": "[IMG_0123 4.20–5.60 s]",
  "У монтажі: ": "In the edit: ",
  "Цей кліп зараз не в монтажі.": "This clip is not in the edit now.",
  "видно {a}–{b} с з {d} с": "showing {a}–{b} s of {d} s",
  "увесь кліп · {d} с": "whole clip · {d} s",
  "Вибрано: {a}–{b} с · {d} с": "Selected: {a}–{b} s · {d} s",
  "на самий початок": "at the very start",
  ", таймлапс ×{x} збережеться": ", the ×{x} timelapse is kept",
  ", швидкість {x}× збережеться": ", speed {x}× is kept",
  "Кадр #{n} «{note}»: посунь межі й натисни «Замінити кадр»{sp}.": "Shot #{n} “{note}”: move the edges and press “Replace shot”{sp}.",
  "Заміна кадру #{n} «{note}» шматком з {clip}: вибери межі й натисни «Замінити кадр».":
    "Replacing shot #{n} “{note}” with a range of {clip}: set the edges and press “Replace shot”.",
  "додаю…": "adding…",
  "✓ Кадр замінено: {clip} {a}–{b} с. Буде в наступній версії — «Зробити версію».":
    "✓ Shot replaced with {clip} {a}–{b} s. It will be in the next version: “Render version”.",
  "✓ Додано {clip} {a}–{b} с. Буде в наступній версії — «Зробити версію».":
    "✓ Added {clip} {a}–{b} s. It will be in the next version: “Render version”.",
  "не вийшло: {e}": "failed: {e}",

  // ---------- download menu
  "Немає версії": "No version",
  "Оптимально для TikTok: H.264, ~15 Мбіт/с, оригінальний звук": "Best for TikTok: H.264, ~15 Mbit/s, original sound",
  "Максимальна якість: зібрано наново з 4K-оригіналів": "Top quality: rebuilt from the 4K originals",
  "4K: збираю з оригіналів… {p}%": "4K: building from the originals… {p}%",
  "~1–3 хв, можна закрити меню": "~1–3 min, you can close this menu",
  "Зробити 4K-версію (≈2 хв)": "Make a 4K version (≈2 min)",
  "2160×3840 з оригінальних кліпів, ~200 МБ": "2160×3840 from the original clips, ~200 MB",
  " · минулого разу помилка: {e}": " · failed last time: {e}",
  "На телефон: запусти <span class=\"mono\">python3 tools/server.py --lan</span> і відкрий адресу з iPhone в тій самій Wi-Fi, тоді файл завантажиться одразу на телефон.":
    "To your phone: run <span class=\"mono\">python3 tools/server.py --lan</span> and open the address on your iPhone on the same Wi-Fi; the file then downloads straight to the phone.",

  // ---------- light tab
  "Світло вже вирівняне між кадрами автоматично. Тут можна підкрутити кожен кадр окремо: зміни видно одразу на відео, а у файлі — після «Зробити версію».":
    "Light is already balanced across shots automatically. Here you can fine-tune each shot: changes show on the video right away, and in the file after “Render version”.",
  "Яскравість": "Brightness",
  "Контраст": "Contrast",
  "Тепло": "Warmth",
  "Повернути автоматичний баланс для цього кадру": "Go back to the automatic balance for this shot",
  "Авто": "Auto",
  "Утримуй, щоб побачити як у версії (клавіша B)": "Hold to see it as in the version (B key)",
  "Утримуй: було / стане": "Hold: before / after",
  "Усі кадри": "All shots",
  "— клік, щоб перейти; ☀ яскравість": "- click to jump; ☀ brightness",
  "вручну": "manual",
  "авто": "auto",
  "яскравість {v}": "brightness {v}",
  "збережено ✓": "saved ✓",
  "помилка": "error",
  "сервер недоступний": "server unavailable",

  // ---------- captions tab
  "+ Додати напис тут": "+ Add caption here",
  "з'явиться з поточного моменту; тягни його прямо на відео": "starts at the current moment; drag it right on the video",
  "Усі написи": "All captions",
  "Усі написи ({n})": "All captions ({n})",
  "клік по напису на відео теж вибирає його": "clicking a caption on the video selects it too",
  "Напис… (Shift+Enter — новий рядок)": "Caption… (Shift+Enter for a new line)",
  "Ваш напис": "Your caption",
  "Готові стилі": "Presets",
  "Шрифт": "Font",
  "Жирний": "Bold",
  "Курсив": "Italic",
  "Великими літерами": "Uppercase",
  "Ж": "B",
  "К": "I",
  "АА": "AA",
  "Ліворуч": "Left",
  "По центру": "Center",
  "Праворуч": "Right",
  "Розмір": "Size",
  "Колір тексту": "Text color",
  "Оформлення": "Style",
  "Без": "None",
  "Контур": "Outline",
  "Плашка": "Box",
  "Колір плашки": "Box color",
  "Колір контуру": "Outline color",
  "Прозорість": "Opacity",
  "Тінь": "Shadow",
  "Розмиття": "Blur",
  "Відстань": "Distance",
  "Напрямок": "Direction",
  "Місце і час": "Position and timing",
  "Вгорі": "Top",
  "Центр": "Center",
  "Внизу": "Bottom",
  "або тягни на відео": "or drag it on the video",
  "Початок тут": "Start here",
  "Кінець тут": "End here",
  "Тривалість": "Duration",
  "плавна поява": "fade in",
  "Видалити напис": "Delete caption",
  "безпечна зона TikTok": "TikTok safe zone",
  "(порожньо)": "(empty)",
  "  · чернетка: зміни текст": "  · draft: change the text",
  "Написів ще немає.": "No captions yet.",
  "У цій версії ще є старий напис — зникне після «Зробити версію».": "This version still has an old caption; it goes away after “Render version”.",
  "У цій версії ще є старі написи — зникне після «Зробити версію».": "This version still has old captions; they go away after “Render version”.",
  "— від плашки": "- cast by the box",
  "— від літер": "- cast by the letters",
  "Смачно": "Tasty",
  "Свій колір": "Custom color",
  "Свій колір тіні": "Custom shadow color",
  "помилка збереження": "save failed",
  "Сучасний": "Modern",
  "Трендовий": "Trendy",
  "Округлий": "Rounded",
  "М'який": "Soft",
  "Елегантний": "Elegant",
  "Вишуканий": "Refined",
  "Рукописний": "Handwritten",
  "Каліграфія": "Calligraphy",
  "Нотатки": "Notepad",
  "Розчерк": "Flourish",
  "Ретро": "Retro",
  "Літній": "Summery",
  "Крейда": "Chalk",
  "Зошит": "Schoolbook",
  "TikTok плашка": "TikTok box",
  "Заголовок": "Headline",
  "Затишний": "Cozy",
  "М'яка": "Soft",
  "Чітка": "Crisp",
  "Довга": "Long",
  "Тепла": "Warm",
  "Світіння": "Glow",
  "Ореол": "Halo",

  // ---------- render a version (header button)
  "Зробити версію · {n}": "Render version · {n}",
  "Є зміни, яких ще немає у файлі: {list}": "Changes not in the file yet: {list}",
  "Змін немає: версія вийде така сама": "No changes: the version would come out the same",
  "Монтаж: {x}": "Edit: {x}",
  "Світло змінено вручну: {list}": "Light changed by hand: {list}",
  "Переходи: {list}": "Transitions: {list}",
  "Написи: {n}": "Captions: {n}",
  "Написи прибрано": "Captions removed",
  "змінено порядок": "order changed",
  "Зберігаю…": "Saving…",
  "Перерендер без змін": "Re-render without changes",
  " (зроблено з інтерфейсу)": " (made in the UI)",
  "Рендер…": "Rendering…",
  "Рендер {p}%": "Rendering {p}%",
  "помилка рендеру: {e}": "render failed: {e}",

  // ---------- transitions tab
  "Переходи між кадрами": "Transitions between shots",
  "Перехід ставиться на склейку біля точки відтворення. Ромби на таймлайні — склейки з переходом.":
    "A transition goes on the cut nearest the playhead. Diamonds on the timeline mark cuts with a transition.",
  "Попередня склейка": "Previous cut",
  "Наступна склейка": "Next cut",
  "Переглянути перехід": "Preview transition",
  "Цей самий перехід на всі склейки": "The same transition on every cut",
  "На всі склейки": "Apply to all cuts",
  "Усі склейки — прямі": "Make every cut a straight cut",
  "Усі прямі": "All straight",
  "Пряма": "Cut",
  "Наплив": "Crossfade",
  "Через чорне": "Dip to black",
  "Спалах": "Flash",
  "Розсип": "Scatter",
  "Зсув ←": "Slide ←",
  "Зсув →": "Slide →",
  "Зсув ↑": "Slide ↑",
  "М'який зсув": "Smooth slide",
  "Шторка": "Wipe",
  "Коло": "Circle",
  "Наїзд": "Zoom in",
  "Радар": "Radar",
  "Накриття": "Cover",
  "Пікселі": "Pixelate",
  "Склейка <b>#{a} → #{b}</b> · {t} с": "Cut <b>#{a} → #{b}</b> · {t} s",
  "У файлі: {x}": "In the file: {x}",
  "Буде: {x} — після «Зробити версію»": "Will be: {x} after “Render version”",
  "готую прев'ю…": "preparing the preview…",
  "прев'ю не вийшло: {e}": "preview failed: {e}",
  "{name} на всіх {n} склейках": ["{name} on {n} cut", "{name} on all {n} cuts"],

  // ---------- effects tab
  "Ефекти накладаються наживо поверх відео, як прев'ю. Фінальний рендер вийде таким самим: ті самі кольорові таблиці й формули. Подобається — надішли Claude, і він зробить нову версію.":
    "Effects play live over the video as a preview. The final render comes out the same: same color tables and formulas. Like it? Send it to Claude for a new version.",
  "Утримуй, щоб побачити без ефектів (клавіша B)": "Hold to see it without effects (B key)",
  "Утримуй: до / після": "Hold: before / after",
  "Скинути все": "Reset all",
  "Готові набори": "Presets",
  "Колір": "Color",
  "— один на вибір; мініатюри показують поточний кадр": "- pick one; thumbnails show the current frame",
  "Текстура": "Texture",
  "Рух": "Motion",
  "Коментар (необов'язково): напр. «світіння тільки на фінальній тарілці»": "Comment (optional): e.g. “glow only on the final plate”",
  "Надіслати Claude: зробити версію з цими ефектами": "Send to Claude: render a version with these effects",
  "WebGL2 недоступний у цьому браузері: прев'ю не працюватиме, але вказівку надіслати можна.":
    "WebGL2 is not available in this browser: the preview won't work, but you can still send the note.",
  "Без кольору": "No color",
  "Як у версії": "As in the version",
  "на всі кадри": "on all shots",
  "лише на поточний кадр": "only on the current shot",
  " (лише кадр #{n} «{note}»)": " (only shot #{n} “{note}”)",
  " (на всі кадри)": " (on all shots)",
  "Вибрано: <b></b>": "Selected: <b></b>",
  "Нічого не вибрано. Почни з готового набору або кольору.": "Nothing selected. Start with a preset or a color.",
  "Ця версія вже з ефектами, прев'ю додасть зверху": "This version already has effects; the preview adds on top",
  "Ефекти: {fx}.": "Effects: {fx}.",
  "надсилаю…": "sending…",
  "надіслано ✓ (видно у «Вказівках»). Напиши Claude «застосуй вказівки».": "sent ✓ (see “Notes”). Tell Claude “apply my notes”.",

  // ---------- shots board
  " · таймлапс ×{x}": " · timelapse ×{x}",
  " · сповільнено ×{x}": " · slowed ×{x}",
  " · швидше ×{x}": " · faster ×{x}",
  "Для цього відео дошки кадрів ще немає.": "No shot board for this video yet.",
  "Для кожного кадру монтажу: мій вибір (перший) і альтернативи з матеріалу. ▶ — подивитись шматок, «Взяти» — одразу в монтаж. Нову версію робить «Зробити версію».":
    "For every shot of the edit: Claude's pick (first) and alternatives from the footage. ▶ plays the range, “Use” puts it straight into the edit. “Render version” makes the new version.",
  "кадру немає в монтажі": "shot is not in the edit",
  "ще не у відео": "not in the video yet",
  "Перейти до цього кадру у відео": "Go to this shot in the video",
  "Подивитись цей шматок": "Watch this range",
  "вибір Claude · ": "Claude's pick · ",
  " · кроп ×{x}": " · crop ×{x}",
  " · без звуку": " · no sound",
  "✓ у монтажі": "✓ in the edit",
  "Взяти": "Use",
  "вношу…": "applying…",
  "{clip} · {a}–{b} с{rate} · клік — закрити": "{clip} · {a}–{b} s{rate} · click to close",

  // ---------- server errors (tools/server.py), shown after «помилка:»
  "порожня вказівка": "empty note",
  "цю версію не можна експортувати": "this version can't be exported",
  "невідомий перехід": "unknown transition",
  "немає такої склейки": "no such cut",
  "потрібні in / out": "in / out are required",
  "неправильний діапазон": "invalid range",
  "немає кадру для заміни": "no shot to replace",
  "немає дошки кадрів": "no shot board",
  "немає такого варіанта": "no such option",
  "цього кадру вже немає в монтажі": "this shot is no longer in the edit",
};

const i18nHas = (k) => Object.prototype.hasOwnProperty.call(EN, k);
const i18nFill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s);
// English when the interface is in English and the key is known; {name} placeholders filled from vars.
// An EN value [singular, plural] is picked by vars.n.
function t(s, vars) {
  let out = s;
  if (LANG === "en") {
    if (i18nHas(s)) {
      const e = EN[s];
      out = Array.isArray(e) ? e[vars && +vars.n === 1 ? 0 : 1] : e;
    } else if (/[Ѐ-ӿ]/.test(s)) t.missing.add(s);
  }
  return i18nFill(out, vars);
}
t.missing = new Set();   // Ukrainian strings asked for in EN without a translation (for testing)
// counts: Ukrainian 1 / 2-4 / many forms (21 кадр, 22 кадри, 25 кадрів); English uses EN[many] = [singular, plural]
function tn(n, one, few, many, vars) {
  const v = Object.assign({ n }, vars);
  if (LANG === "en") return t(many, v);
  const a = Math.abs(n) % 10, b = Math.abs(n) % 100;
  return i18nFill(a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many, v);
}

// static HTML: every text node and title / placeholder / aria-label that matches a key (whitespace-normalised)
// is replaced; the whitespace around a text node is kept, so inline markup next to it still lines up
function translateDom(root) {
  if (LANG !== "en" || !root) return;
  const look = (s) => {
    const k = s.replace(/\s+/g, " ").trim();
    return k && i18nHas(k) && typeof EN[k] === "string" ? EN[k] : null;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
    const v = n.nodeValue, en = look(v);
    if (en != null) n.nodeValue = v.match(/^\s*/)[0] + en + v.match(/\s*$/)[0];
  }
  const els = [root, ...root.querySelectorAll("[title], [placeholder], [aria-label]")];
  for (const el of els) {
    for (const a of ["title", "placeholder", "aria-label"]) {
      const v = el.getAttribute && el.getAttribute(a);
      const en = v && look(v);
      if (en != null) el.setAttribute(a, en);
    }
  }
}

// UK | EN switch in the header: saves the choice and reloads (pending edits are saved first)
async function setLang(l) {
  if (l !== "uk" && l !== "en") return;
  langStore.set("lang", l);
  if (l === LANG) return;
  try { if (window.flushPending) await window.flushPending(); } catch (e) { /* reload anyway */ }
  location.reload();
}
(function initLangSwitch() {
  for (const b of document.querySelectorAll("#langSwitch button[data-lang]")) {
    const on = b.dataset.lang === LANG;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.addEventListener("click", () => setLang(b.dataset.lang));
  }
})();

document.title = t(document.title);
translateDom(document.body);
