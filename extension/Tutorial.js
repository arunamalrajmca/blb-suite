(function () {
    try {
        const version = chrome.runtime.getManifest().version;
        const badge = document.getElementById('extensionVersion');
        const footer = document.getElementById('footerVersion');
        if (badge) badge.textContent = version;
        if (footer) footer.textContent = version;
        document.title = 'Blue Letter Bible Suite ' + version + ' — User Guide';
    } catch (_) {}
})();


(function () {
    const example = document.getElementById('multiVerseExample');
    const selectButton = document.getElementById('selectMultiVerseExample');
    if (!example || !selectButton) return;

    selectButton.addEventListener('click', function () {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(example);
        selection.removeAllRanges();
        selection.addRange(range);
        selectButton.textContent = '✓';
        setTimeout(() => { selectButton.textContent = '↖'; }, 900);
    });
})();



(function () {
    const bookMap = {
        gen:'gen', exo:'exo', lev:'lev', num:'num', deu:'deu', jos:'jos', jdg:'jdg', rth:'rth',
        '1sa':'1sa', '2sa':'2sa', '1ki':'1ki', '2ki':'2ki', '1ch':'1ch', '2ch':'2ch', ezr:'ezr', neh:'neh', est:'est',
        job:'job', psa:'psa', pro:'pro', ecc:'ecc', sng:'sng', isa:'isa', jer:'jer', lam:'lam', eze:'eze', dan:'dan', hos:'hos',
        joe:'joe', amo:'amo', oba:'oba', jon:'jon', mic:'mic', nah:'nah', hab:'hab', zep:'zep', hag:'hag', zec:'zec', mal:'mal',
        mat:'mat', mar:'mar', luk:'luk', jhn:'jhn', act:'act', rom:'rom', '1co':'1co', '2co':'2co', gal:'gal', eph:'eph',
        phl:'phl', col:'col', '1th':'1th', '2th':'2th', '1ti':'1ti', '2ti':'2ti', tit:'tit', phm:'phm', heb:'heb', jas:'jas',
        '1pe':'1pe', '2pe':'2pe', '1jo':'1jo', '2jo':'2jo', '3jo':'3jo', jde:'jde', rev:'rev'
    };
    const aliases = {
        genesis:'gen', gen:'gen', exodus:'exo', exo:'exo', leviticus:'lev', lev:'lev', numbers:'num', num:'num',
        deuteronomy:'deu', deu:'deu', joshua:'jos', jos:'jos', judges:'jdg', jdg:'jdg', ruth:'rth', rth:'rth',
        '1 samuel':'1sa', '1samuel':'1sa', '1sa':'1sa', '2 samuel':'2sa', '2samuel':'2sa', '2sa':'2sa',
        '1 kings':'1ki', '1kings':'1ki', '1ki':'1ki', '2 kings':'2ki', '2kings':'2ki', '2ki':'2ki',
        '1 chronicles':'1ch', '1chronicles':'1ch', '1ch':'1ch', '2 chronicles':'2ch', '2chronicles':'2ch', '2ch':'2ch',
        ezra:'ezr', ezr:'ezr', nehemiah:'neh', neh:'neh', esther:'est', est:'est', job:'job', psalms:'psa', psalm:'psa', psa:'psa',
        proverbs:'pro', prov:'pro', pro:'pro', ecclesiastes:'ecc', ecc:'ecc', 'song of solomon':'sng', song:'sng', sng:'sng',
        isaiah:'isa', isa:'isa', jeremiah:'jer', jer:'jer', lamentations:'lam', lam:'lam', ezekiel:'eze', eze:'eze', daniel:'dan', dan:'dan',
        hosea:'hos', hos:'hos', joel:'joe', joe:'joe', amos:'amo', amo:'amo', obadiah:'oba', oba:'oba', jonah:'jon', jon:'jon', micah:'mic', mic:'mic',
        nahum:'nah', nah:'nah', habakkuk:'hab', hab:'hab', zephaniah:'zep', zep:'zep', haggai:'hag', hag:'hag', zechariah:'zec', zec:'zec', malachi:'mal', mal:'mal',
        matthew:'mat', matt:'mat', mat:'mat', mark:'mar', mk:'mar', mar:'mar', luke:'luk', lk:'luk', lu:'luk', luk:'luk', john:'jhn', jhn:'jhn',
        acts:'act', act:'act', romans:'rom', rom:'rom', ro:'rom', '1 corinthians':'1co', '1corinthians':'1co', '1co':'1co', '2 corinthians':'2co', '2corinthians':'2co', '2co':'2co',
        galatians:'gal', gal:'gal', ephesians:'eph', eph:'eph', philippians:'phl', phil:'phl', phl:'phl', colossians:'col', col:'col',
        '1 thessalonians':'1th', '1thessalonians':'1th', '1th':'1th', '2 thessalonians':'2th', '2thessalonians':'2th', '2th':'2th',
        '1 timothy':'1ti', '1timothy':'1ti', '1ti':'1ti', '2 timothy':'2ti', '2timothy':'2ti', '2ti':'2ti', titus:'tit', tit:'tit',
        philemon:'phm', phm:'phm', hebrews:'heb', heb:'heb', james:'jas', jas:'jas', '1 peter':'1pe', '1peter':'1pe', '1pe':'1pe',
        '2 peter':'2pe', '2peter':'2pe', '2pe':'2pe', '1 john':'1jo', '1john':'1jo', '1jo':'1jo', '2 john':'2jo', '2john':'2jo', '2jo':'2jo',
        '3 john':'3jo', '3john':'3jo', '3jo':'3jo', jude:'jde', jde:'jde', revelation:'rev', rev:'rev'
    };
    const ranges = {ot:1, torah:2, hb:3, pb:4, wl:5, pp:6, maj:7, min:8, nt:9, mmlj:10, lkep:11, pep:12, gep:13, lj:14};

    function buildRunUrl(raw) {
        let t = raw.trim();
        const low = t.toLowerCase();
        if (!t) return 'https://www.blueletterbible.org/';

        const versionMatch = t.match(/\s+(kjv|nlt|niv|esv|nasb|nkjv|amp|csb|hcsb|asv|ylt|darby|web|webus|gnt|gnb|msg|net|nrsva|nrsv|rsv|rsvce|ceb|cev|ncv|nheb|isv|nasb95|nasb77|lsb|lamsa|brenton|jub|akjv|kj2000|mev|tlb|voice|ampc|nltse|nivuk|nkjvuk)\s*$/i);
        const version = versionMatch ? versionMatch[1].toLowerCase() : 'kjv';
        if (versionMatch) t = t.slice(0, versionMatch.index).trim();

        if (/^\s*['"][\s\S]*['"]\s*$/.test(t)) {
            const phrase = t.replace(/^\s*['"]|['"]\s*$/g, '').trim();
            return phrase ? 'https://www.blueletterbible.org/search/search.cfm?Criteria=' + encodeURIComponent(phrase).replace(/%20/g, '+') : null;
        }

        const g = t.toLowerCase().match(/^(g|h)\s*(\d+)(\.?)$/);
        if (g) {
            const n = Number(g[2]);
            if (g[3] === '.') return 'https://www.blueletterbible.org/search/search.cfm?Criteria=' + g[1] + g[2];
            if ((g[1] === 'g' && n <= 5624) || (g[1] === 'h' && n <= 8674)) return 'https://www.blueletterbible.org/lexicon/' + g[1] + g[2] + '/kjv/' + (g[1] === 'g' ? 'tr' : 'wlc') + '/0-1/';
            return null;
        }

        const compact = t.toLowerCase().match(/^([a-z0-9]+)(\d+)\s+(\d+)(?:\s*-\s*(\d+))?$/);
        if (compact) {
            const compactBook = aliases[compact[1]];
            if (compactBook) {
                const chapter = Number(compact[2]);
                const from = Number(compact[3]);
                const to = compact[4] ? Number(compact[4]) : from;
                const range = from === to ? String(from) : from + '-' + to;
                return 'https://www.blueletterbible.org/' + version + '/' + bookMap[compactBook] + '/' + chapter + '/' + range + '/';
            }
        }

        const tokens = t.replace(/:/g, ' : ').replace(/-/g, ' - ').trim().split(/\s+/);
        let bookKey = null, rest = '';
        for (let take = Math.min(3, tokens.length); take >= 1; take--) {
            const candidate = tokens.slice(0, take).join(' ').toLowerCase();
            if (aliases[candidate]) { bookKey = aliases[candidate]; rest = tokens.slice(take).join(' '); break; }
        }

        if (bookKey) {
            let m = rest.match(/^(\d+)\s*:\s*(\d+)(?:\s*-\s*(\d+))?$/);
            if (!m) m = rest.match(/^(\d+)\s+(\d+)(?:\s*-\s*(\d+))?$/);
            if (m) {
                const chapter = Number(m[1]);
                const from = Number(m[2]);
                const to = m[3] ? Number(m[3]) : from;
                const range = from === to ? String(from) : from + '-' + to;
                return 'https://www.blueletterbible.org/' + version + '/' + bookMap[bookKey] + '/' + chapter + '/' + range + '/';
            }
            if (/^\d+(?:\s*-\s*\d+)?$/.test(rest) && ['rth','oba','phm','2jo','3jo','jde'].includes(bookKey)) {
                const m1 = rest.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
                const from = Number(m1[1]);
                const to = m1[2] ? Number(m1[2]) : from;
                const range = from === to ? String(from) : from + '-' + to;
                return 'https://www.blueletterbible.org/' + version + '/' + bookMap[bookKey] + '/1/' + range + '/';
            }
            if (!rest) return 'https://www.blueletterbible.org/' + version + '/' + bookMap[bookKey] + '/1/1/';
        }

        const parts = t.toLowerCase().split(/\s+/);
        const last = parts[parts.length - 1];
        if (ranges[last]) {
            const criteria = parts.slice(0, -1).join(' ').trim();
            if (criteria) return 'https://www.blueletterbible.org/search/search.cfm?Criteria=' + encodeURIComponent(criteria).replace(/%20/g, '+') + '&csr=' + ranges[last] + '#s=s_primary_0_1';
        }
        return 'https://www.blueletterbible.org/search/search.cfm?Criteria=' + encodeURIComponent(t).replace(/%20/g, '+');
    }

    function copyText(text, button) {
        const value = /^b\s+/i.test(text) ? text.replace(/^b\s+/i, '') : text;
        const done = () => {
            const old = button.textContent;
            button.textContent = '✓';
            setTimeout(() => { button.textContent = old; }, 900);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done));
        } else {
            fallbackCopy(value, done);
        }
    }

    function fallbackCopy(value, done) {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } finally { area.remove(); }
    }

    function runCommand(text, button) {
        const query = text.replace(/^b\s+/i, '').trim();
        if (!query) return;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            try {
                chrome.runtime.sendMessage({type:'blbSuiteRunBCommand', text:query}, response => {
                    if (chrome.runtime.lastError || !response || !response.ok) window.open(buildRunUrl(query), '_blank');
                    else flashRun(button);
                });
                return;
            } catch (_) {}
        }
        const url = buildRunUrl(query);
        if (url) { window.open(url, '_blank'); flashRun(button); }
    }

    function flashRun(button) {
        const old = button.textContent;
        button.textContent = '✓';
        setTimeout(() => { button.textContent = old; }, 900);
    }

    function addCommandControls(command, text, inline = true) {
        if (!text || command.closest('.command-shell')) return;

        const shell = document.createElement(inline ? 'span' : 'div');
        shell.className = 'command-shell';
        if (!inline) shell.style.display = 'flex';
        command.parentNode.insertBefore(shell, command);
        shell.appendChild(command);

        const tools = document.createElement('span');
        tools.className = 'command-tools';

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'command-tool';
        copy.textContent = '⧉';
        copy.title = /^b\s+/i.test(text) ? 'Copy command input (without b)' : 'Copy';
        copy.setAttribute('aria-label', copy.title);
        copy.addEventListener('click', () => copyText(text, copy));
        tools.appendChild(copy);

        if (/^b\s+/i.test(text) && !/^(?:b\s+)?(?:ON|OFF|save|export)\s*$/i.test(text)) {
            const run = document.createElement('button');
            run.type = 'button';
            run.className = 'command-tool';
            run.textContent = '▶';
            run.title = 'Run command';
            run.setAttribute('aria-label', 'Run command');
            if (/^b\s+(save|export)\s*$/i.test(text) && !(typeof chrome !== 'undefined' && chrome.runtime)) {
                run.disabled = true;
                run.title = 'Run from the extension Tutorial page';
                run.style.opacity = '0.45';
                run.style.cursor = 'default';
            }
            run.addEventListener('click', () => runCommand(text, run));
            tools.appendChild(run);
        }
        shell.appendChild(tools);
    }

    document.querySelectorAll('.command').forEach(command => {
        addCommandControls(command, command.textContent.trim(), true);
    });

    // Add the same Copy / Run controls to command examples written as <code>
    // inside tables (and other table cells).
    document.querySelectorAll('table td code').forEach(command => {
        const text = command.textContent.trim();
        if (/^b\s+/i.test(text)) addCommandControls(command, text, true);
    });

    // Section 15 uses <pre> blocks for troubleshooting commands. Give those
    // command examples the same controls as the inline command examples.
    document.querySelectorAll('#troubleshooting pre').forEach(command => {
        const text = command.textContent.trim();
        if (/^b\s+/i.test(text)) addCommandControls(command, text, false);
    });

    // Installation-page browser URLs get Copy buttons.
    document.querySelectorAll('.url-copy[data-copy]').forEach(button => {
        button.addEventListener('click', () => {
            const text = button.getAttribute('data-copy');
            if (!text) return;
            const done = () => {
                const old = button.textContent;
                button.textContent = '✓';
                setTimeout(() => { button.textContent = old; }, 900);
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done).catch(() => {});
                return;
            }
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            try { document.execCommand('copy'); done(); } finally { area.remove(); }
        });
    });
})();



(function () {
    const root = document.documentElement;
    const button = document.getElementById("themeToggle");

    function setTheme(theme) {
        root.setAttribute("data-theme", theme);

        if (theme === "dark") {
            button.textContent = "☀️ Light";
            button.title = "Switch to light theme";
        } else {
            button.textContent = "🌙 Dark";
            button.title = "Switch to dark theme";
        }

        localStorage.setItem("blbSuiteTheme", theme);
    }

    const savedTheme = localStorage.getItem("blbSuiteTheme");

    setTheme(savedTheme === "light" ? "light" : "dark");

    button.addEventListener("click", function () {
        const currentTheme = root.getAttribute("data-theme");
        setTheme(currentTheme === "dark" ? "light" : "dark");
    });
})();

