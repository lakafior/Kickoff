function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    // macOS 13 renamed Safari's Preferences to Settings; each language's Main.html
    // carries that wording in data-settings.
    if (useSettingsInsteadOfPreferences) {
        for (const element of document.querySelectorAll('[data-settings]')) {
            element.innerText = element.dataset.settings;
        }
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
