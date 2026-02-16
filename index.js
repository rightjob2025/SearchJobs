import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

const SITE_CONFIGS = {
    careerbank: {
        url: 'https://careerbank-jobsearch.com/jobsearch/',
        loginUrl: 'https://careerbank-jobsearch.com/wp-login.php',
        loginSelectors: {
            user: 'input#user_login',
            pass: 'input#user_pass',
            button: 'input#wp-submit',
            captcha: 'input#siteguard_captcha'
        },
        searchSelectors: {
            industry: 'select#feas_1_2',
            jobCategory: 'input[name="c[]"]'
        },
        selectors: {
            item: '.panel.panel-default, .feas_job_list_item',
            title: '.job_detail_h3 a, .feas_job_title a',
            company: '.job_detail_td, .feas_job_company',
            location: '.job_detail_td, .feas_job_location',
            salary: '.job_detail_td, .feas_job_salary',
            date: '.feas_job_date'
        }
    },
    jobmiru: {
        url: 'https://rightjob.app.jobmiru.cloud/p/jobs',
        loginUrl: 'https://rightjob.app.jobmiru.cloud/auth/signin',
        loginSelectors: {
            user: 'input[name="email"]',
            pass: 'input[name="password"]',
            button: 'button[type="submit"]'
        },
        searchSelectors: {
            keyword: 'input[placeholder*="リモートワーク"]',
            location: 'input[data-dd-action-name="click_search_field_location"], input[placeholder*="東京"]',
            jobCategory: 'input[data-dd-action-name="click_search_field_name"], input[placeholder*="セールス"]'
        },
        selectors: {
            item: 'tr.grid, tbody tr',
            title: 'td:nth-child(1) a',
            company: 'td:nth-child(1) .text-gray-600',
            location: 'td:nth-child(4)',
            salary: 'td:nth-child(3)',
            date: ''
        }
    },
    jobins: {
        url: 'https://jobins.jp/agent/',
        loginUrl: 'https://jobins.jp/agent/login',
        loginSelectors: {
            user: '#email',
            pass: '#password',
            button: '#login-button-submit'
        },
        selectors: {
            item: '[class*="jb-shadow"], [class*="jb-border"], .job-card',
            title: 'h4, [class*="jb-text-agent-secondary"]',
            company: '[class*="jb-text-slate-600"]',
            location: '.job-location',
            salary: '.job-salary'
        }
    }
};

let browserContext = null;

const getPersistentContext = async (headless = true) => {
    const contextOptions = {
        headless,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-position=0,0',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
        ],
        ignoreDefaultArgs: ['--enable-automation']
    };

    if (browserContext) {
        try {
            await browserContext.pages();
        } catch (e) {
            browserContext = null;
        }
    }

    if (!browserContext) {
        browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, contextOptions);
        browserContext.on('close', () => {
            browserContext = null;
        });
    }
    return browserContext;
};

const performLogin = async (page, db, creds, send) => {
    const config = SITE_CONFIGS[db];
    send({ type: 'log', message: `${db}: 自動ログインを実行中...`, level: 'info' });

    try {
        await page.goto(config.loginUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => { });

        if (db === 'jobmiru') {
            const gatewayBtn = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('a, button'));
                const btn = btns.find(b => {
                    const href = b.getAttribute('href') || '';
                    const text = b.innerText || '';
                    return href.includes('/auth/redirect') || text.includes('ログインする');
                });

                if (btn && !document.querySelector('input[name="email"]')) {
                    btn.click();
                    return true;
                }
                return false;
            });
            if (gatewayBtn) {
                send({ type: 'log', message: `${db}: ゲートウェイボタンをクリックしました。リダイレクトを待機します...`, level: 'info' });
                await page.waitForTimeout(3000);
            }
        }

        if (await page.isVisible(config.loginSelectors.user)) {
            // Clear fields using keyboard to override browser autofill (more robust than fill('') )
            const clearAndFill = async (selector, value) => {
                await page.click(selector);
                await page.keyboard.press('Meta+A'); // Mac shortcut
                await page.keyboard.press('Control+A'); // Windows/Linux shortcut
                await page.keyboard.press('Backspace');
                await page.fill(selector, value);
            };

            await clearAndFill(config.loginSelectors.user, creds.user || creds.email || '');
            await clearAndFill(config.loginSelectors.pass, creds.pass || creds.password || '');

            // Careerbank (SiteGuard) CAPTCHA Detection
            const captchaImg = await page.evaluate(() => {
                const img = document.querySelector('img[src*="siteguard_captcha_img"]');
                return img ? img.src : null;
            }) || await page.evaluate(() => {
                const imgs = Array.from(document.querySelectorAll('img'));
                const captcha = imgs.find(img => img.src.includes('captcha') ||
                    img.alt.includes('CAPTCHA'));
                return captcha ? captcha.src : null;
            });

            if (captchaImg) {
                send({ type: 'log', message: `${db}: 画像認証（ひらがな4文字）を検出しました。`, level: 'warning' });
                send({ type: 'captcha_required', db, image: captchaImg });

                const inputPath = path.join(__dirname, 'captcha_input.txt');
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

                let captchaValue = '';
                for (let i = 0; i < 60; i++) {
                    if (fs.existsSync(inputPath)) {
                        captchaValue = fs.readFileSync(inputPath, 'utf8').trim();
                        fs.unlinkSync(inputPath);
                        break;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }

                if (captchaValue) {
                    const captchaSelector = config.loginSelectors.captcha || 'input#siteguard_captcha';
                    await page.fill(captchaSelector, captchaValue).catch(() => { });
                }
            }

            await page.click(config.loginSelectors.button);
            await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => { });

            // Success check
            const currentUrl = page.url();
            if (currentUrl.includes('signin') || currentUrl.includes('login') || await page.isVisible(config.loginSelectors.user)) {
                send({ type: 'log', message: `${db}: ログインに失敗しました。ID/PASSまたは画像認証が間違っている可能性があります。`, level: 'error' });
            } else {
                send({ type: 'log', message: `${db}: ログイン成功。`, level: 'success' });
            }
        } else {
            send({ type: 'log', message: `${db}: 既にログイン済み、またはフォームが見つかりませんのでログイン行程をスキップします。`, level: 'info' });
        }
    } catch (e) {
        send({ type: 'log', message: `${db} ログインエラー: ${e.message}`, level: 'warning' });
    }
};

const extractJobsFromPage = async (page, config, source) => {
    return await page.evaluate(({ selectors, source }) => {
        let items = Array.from(document.querySelectorAll(selectors.item));

        items = items.filter(el => {
            const isPopup = el.closest('header, [class*="header"], [class*="popover"], [class*="modal"], [role="dialog"], [class*="Notification"], [class*="dropdown"], [class*="jb-absolute"]');
            const isSidebar = el.closest('aside, [class*="sidebar"]');
            return !isPopup && !isSidebar;
        });

        if (source === 'jobins') {
            items = items.filter(el => {
                const text = el.innerText;
                const hasId = text.includes('求人ID');
                const isNotNotification = !text.includes('通知') && !text.includes('お知らせ') && !text.includes('既読');
                return hasId && isNotNotification;
            });
        }

        if (source === 'jobins') {
            const seen = new Set();
            return items.map((item, idx) => {
                const titleEl = item.querySelector(selectors.title);
                let title = '無題の求人';
                if (titleEl) title = titleEl.innerText?.trim() || titleEl.textContent?.trim() || '無題の求人';
                else {
                    const h = item.querySelector('h1, h2, h3, h4, [class*="job-title"]');
                    title = h?.innerText?.trim() || h?.textContent?.trim() || '無題の求人';
                }

                if (title.includes('通知') || title.includes('お知らせ') || title.includes('既読') || title.includes('メッセージ')) return null;

                const text = item.innerText || '';
                const compMatch = text.match(/採用企業\s*([^\n]+)/);
                const company = compMatch ? compMatch[1].trim() : '社名非公開';
                const salMatch = text.match(/(\d+万円[～~]\d+万円|\d+万円～|\d+万円)/);
                const salary = salMatch ? salMatch[0] : '要確認';

                // 完全重複排除のためのキー
                const key = `${title}-${company}-${salary}`;
                if (seen.has(key)) return null;
                seen.add(key);

                const url = `https://jobins.jp/agent/job/click_index=${idx}`;

                let location = '不明';
                const locs = ['東京', '神奈川', '埼玉', '千葉', '大阪', '京都', '兵庫', '愛知', '福岡', '北海道'];
                for (const l of locs) { if (text.includes(l)) { location = l; break; } }

                const updateMatch = text.match(/(\d{4}[/-]\d{1,2}[/-]\d{1,2})|(\d+日前)/);
                const statusMatch = text.match(/(募集中|面談設定済|選考中|内定|不合格|辞退)/);

                return {
                    source, title, url, company, location, salary,
                    updateDate: updateMatch ? updateMatch[0] : '',
                    status: statusMatch ? statusMatch[0] : ''
                };
            }).filter(item => item !== null);
        }

        return items.map((item) => {
            const titleEl = item.querySelector(selectors.title);
            let title = '無題の求人';

            if (titleEl) {
                title = titleEl.innerText?.trim() || titleEl.textContent?.trim() || '無題の求人';
            }

            // careerbank 特有の th/td 構造への対応
            const findTextByTh = (label) => {
                const ths = Array.from(item.querySelectorAll('th'));
                const th = ths.find(el => el.innerText.includes(label));
                return th?.nextElementSibling?.innerText?.trim() || '';
            };

            let company = '';
            let location = '';
            let salary = '';

            if (source === 'careerbank') {
                company = findTextByTh('企業名');
                location = findTextByTh('勤務地');
                salary = findTextByTh('年収');
            } else {
                company = item.querySelector(selectors.company)?.innerText?.trim();
                location = item.querySelector(selectors.location)?.innerText?.trim();
                salary = item.querySelector(selectors.salary)?.innerText?.trim();
            }

            return {
                source,
                title,
                url: (titleEl && titleEl.tagName === 'A') ? titleEl.href : '',
                company: company || '社名非公開',
                location: location || '不明',
                salary: salary || '要確認',
                updateDate: '',
                status: ''
            };
        }).filter(item => item !== null && item.url);

    }, { selectors: config.selectors, source });
};

// 詳細条件に合致しているか再検証する関数
const checkJobMatch = (job, filters) => {
    const { query, location, minSalary } = filters;
    const fullText = (
        (job.title || "") +
        (job.detail?.description || "") +
        (job.detail?.requirements || "") +
        (job.company || "")
    ).toLowerCase();

    // 1. キーワードの厳密チェック (AND検索: 全てのキーワードが含まれていること)
    if (query) {
        const keywords = query.split(/[\s,，]+/).filter(k => k.trim());
        for (const kw of keywords) {
            if (!fullText.includes(kw.toLowerCase())) {
                return { match: false, reason: `キーワード「${kw}」が見つかりません` };
            }
        }
    }

    // 2. 年収の再検証
    if (minSalary) {
        const minVal = parseInt(minSalary);
        if (!isNaN(minVal)) {
            // "500万円～700万円" のような文字列から数値を抽出
            const salaryMatch = (job.salary || "").match(/(\d+)万円/);
            if (salaryMatch) {
                const jobMinSalary = parseInt(salaryMatch[1]);
                if (jobMinSalary < minVal) {
                    return { match: false, reason: `年収(${jobMinSalary}万)が希望(${minVal}万)を下回っています` };
                }
            }
        }
    }

    // 3. 勤務地の再検証
    if (location && location !== '全国' && location !== '不明') {
        const jobLoc = (job.location || "").toLowerCase();
        const filterLoc = location.toLowerCase();
        // 片方がもう片方を含んでいればOK (例: 「東京都」と「東京」)
        if (!jobLoc.includes(filterLoc) && !filterLoc.includes(jobLoc)) {
            return { match: false, reason: `勤務地「${job.location}」が条件「${location}」に合致しません` };
        }
    }

    return { match: true };
};

// extractJobDetails moved to bottom for better organization


app.get('/api/open-browser', async (req, res) => {
    const { db } = req.query;
    const config = SITE_CONFIGS[db];
    if (!config) return res.status(400).send('Invalid DB');

    const context = await getPersistentContext(false);
    const page = await context.newPage();
    await page.goto(config.url);
    res.send('Browser opened');
});

app.post('/api/input', (req, res) => {
    const { value } = req.body;
    fs.writeFileSync(path.join(__dirname, 'captcha_input.txt'), value);
    res.json({ success: true });
});

app.post('/api/collect', async (req, res) => {
    const { query, location, jobCategory, minSalary, experience, appCategory, databases, credentials } = req.body;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    const send = (data) => res.write(JSON.stringify(data) + '\n');

    try {
        const context = await getPersistentContext(false);

        for (const db of databases) {
            const config = SITE_CONFIGS[db];
            if (!config) continue;
            const page = await context.newPage();

            try {
                if (credentials && credentials[db]) {
                    await performLogin(page, db, credentials[db], send);
                }

                if (db === 'jobmiru' || db === 'jobins' || db === 'careerbank') {
                    send({ type: 'log', message: `${db} で画面を読み込んでいます...`, level: 'info' });

                    const pageUrl = page.url();
                    const configUrlObj = new URL(config.url);
                    if (!pageUrl.includes(configUrlObj.hostname) || pageUrl.includes('login') || pageUrl.includes('wp-login')) {
                        await page.goto(config.url, { waitUntil: 'load', timeout: 60000 });
                    }

                    if (db === 'jobins') {
                        await page.waitForTimeout(5000);
                        await page.evaluate(() => {
                            const btns = Array.from(document.querySelectorAll('a, button, li'));
                            const btn = btns.find(el => el.innerText.includes('求人検索') || el.innerText.includes('求人/推薦'));
                            if (btn) btn.click();
                        });
                        await page.waitForTimeout(5000);
                    }

                    try {
                        const searchSelector = db === 'careerbank' ? 'input#feas_1_0, input[name="s"]' : 'input[placeholder*="ID、求人名"], input[placeholder*="仕事内容"], input[placeholder*="キーワード"], input[placeholder*="フリーワード"], input.search-input, [class*="search"] input, input[placeholder*="例）"]';

                        let searchBox = await page.waitForSelector(searchSelector, { visible: true, timeout: 30000 }).catch(async () => {
                            send({ type: 'log', message: `${db}: 検索窓が見つかりません。リロードして再試行します...`, level: 'warning' });
                            await page.reload({ waitUntil: 'load' });
                            return await page.waitForSelector(searchSelector, { visible: true, timeout: 20000 }).catch(() => null);
                        });

                        if (db === 'jobins') {
                            try {
                                const needsSwitch = await page.evaluate(() => {
                                    const drop = document.querySelector('[class*="jb-operator-dropdown"]');
                                    return drop && !drop.innerText.includes('AND');
                                });
                                if (needsSwitch) {
                                    await page.click('[class*="jb-operator-dropdown"] button');
                                    await page.waitForTimeout(1000);
                                    await page.evaluate(() => {
                                        const items = Array.from(document.querySelectorAll('div, span, li, a'));
                                        const andOpt = items.find(el => el.innerText.trim().startsWith('AND'));
                                        if (andOpt) andOpt.click();
                                    });
                                    await page.waitForTimeout(1000);
                                }
                            } catch (e) { }
                        }

                        if (db === 'jobins') {
                            // 応募区分の設定 (中途/新卒など)
                            if (appCategory) {
                                try {
                                    const labelMap = { 'career': '中途', 'new-graduate': '新卒' };
                                    const targetText = labelMap[appCategory];
                                    send({ type: 'log', message: `Jobins: 応募区分「${targetText}」をセット中...`, level: 'info' });
                                    await page.evaluate((txt) => {
                                        const labels = Array.from(document.querySelectorAll('label, div, span'));
                                        const match = labels.find(l => l.innerText?.trim() === txt);
                                        if (match) {
                                            const cb = match.querySelector('input[type="checkbox"]');
                                            if (cb) { if (!cb.checked) cb.click(); }
                                            else match.click();
                                        }
                                    }, targetText);
                                    await page.waitForTimeout(1000);
                                } catch (e) { }
                            }

                            // 最低年収の設定
                            if (minSalary) {
                                try {
                                    send({ type: 'log', message: `Jobins: 最低年収「${minSalary}万円」をセット中...`, level: 'info' });
                                    const setSalary = await page.evaluate((val) => {
                                        const elements = Array.from(document.querySelectorAll('div, span, label'));
                                        const label = elements.find(el => el.innerText.includes('最低年収'));
                                        if (!label) return false;

                                        // 付近のinput [placeholder="入力"] を探す
                                        const container = label.closest('div[class*="jb-"]') || label.parentElement;
                                        const input = container?.parentElement?.querySelector('input[placeholder="入力"], input[type="number"]') ||
                                            document.querySelector('input[placeholder="入力"]');

                                        if (input) {
                                            input.value = val;
                                            input.dispatchEvent(new Event('input', { bubbles: true }));
                                            input.dispatchEvent(new Event('change', { bubbles: true }));
                                            return true;
                                        }
                                        return false;
                                    }, minSalary);
                                    if (!setSalary) send({ type: 'log', message: `Jobins: 年収入力欄が見つかりませんでした。`, level: 'warning' });
                                    await page.waitForTimeout(1000);
                                } catch (e) { }
                            }

                            // 経験/未経験の設定
                            if (experience === 'no-experience') {
                                try {
                                    send({ type: 'log', message: `Jobins: 「未経験OK」をセット中...`, level: 'info' });
                                    await page.evaluate(() => {
                                        const labels = Array.from(document.querySelectorAll('label, div, span'));
                                        ['職種未経験OK', '完全未経験OK'].forEach(txt => {
                                            const match = labels.find(l => l.innerText?.includes(txt));
                                            if (match) {
                                                const cb = match.querySelector('input[type="checkbox"]');
                                                if (cb && !cb.checked) cb.click();
                                                else if (!cb) match.click();
                                            }
                                        });
                                    });
                                    await page.waitForTimeout(2000);
                                } catch (e) { }
                            }

                            const applyJoBinsFilter = async (label, value) => {
                                if (!value) return;
                                try {
                                    send({ type: 'log', message: `Jobins: ${label}「${value}」を選択中...`, level: 'info' });

                                    // 1. モーダルを開く
                                    const openResult = await page.evaluate((l) => {
                                        const labels = Array.from(document.querySelectorAll('label, div, span'));
                                        const targetLabel = labels.find(el => el.innerText?.trim() === l);
                                        if (!targetLabel) return false;

                                        // その項目に関連する入力フィールドまたはボタンを探す
                                        const container = targetLabel.closest('div[class*="jb-"], .jb-border') || targetLabel.parentElement;
                                        const btn = container.querySelector('button, [class*="cursor-pointer"], .jb-border') || container;
                                        btn.click();
                                        return true;
                                    }, label);

                                    if (!openResult) {
                                        send({ type: 'log', message: `Jobins: ${label}の選択エリアが見つかりません。`, level: 'warning' });
                                        return;
                                    }
                                    await page.waitForTimeout(2000);

                                    // 2. モーダル内での選択
                                    const selectResult = await page.evaluate(async ({ l, v }) => {
                                        const modal = document.querySelector('[class*="jb-shadow-"], [role="dialog"], [class*="modal"]') || document.body;

                                        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

                                        // モーダル内の「列」を特定する (通常、横並びのdiv)
                                        const getColumns = () => {
                                            const containers = Array.from(modal.querySelectorAll('div')).filter(el => {
                                                const style = window.getComputedStyle(el);
                                                return (style.overflowY === 'auto' || style.overflow === 'auto') && el.offsetHeight > 150;
                                            });
                                            // 重複（親要素など）を除外
                                            return containers.filter(c => !containers.some(other => other !== c && other.contains(c)));
                                        };

                                        const findInColumn = (column, text, exact = false) => {
                                            if (!column) return null;
                                            const els = Array.from(column.querySelectorAll('li, div, span, label, button'));
                                            return els.find(el => {
                                                const t = (el.innerText || "").trim().replace(/\n/g, ' ');
                                                if (exact) return t === text;
                                                return t.includes(text);
                                            });
                                        };

                                        const cols = getColumns();

                                        if (l === '勤務地') {
                                            const regionMap = {
                                                '東京都': '首都圏', '神奈川県': '首都圏', '埼玉県': '首都圏', '千葉県': '首都圏', '茨城県': '北関東', '栃木県': '北関東', '群馬県': '北関東',
                                                '大阪府': '近畿', '京都府': '近畿', '兵庫県': '近畿', '奈良県': '近畿', '和歌山県': '近畿', '滋賀県': '近畿',
                                                '愛知県': '東海', '静岡県': '東海', '岐阜県': '東海', '三重県': '東海',
                                                '福岡県': '九州', '佐賀県': '九州', '長崎県': '九州', '熊本県': '九州', '大分県': '九州', '宮崎県': '九州', '鹿児島県': '九州', '沖縄県': '九州',
                                                '北海道': '北海道', '青森県': '東北', '岩手県': '東北', '宮城県': '東北', '秋田県': '東北', '山形県': '東北', '福島県': '東北'
                                            };
                                            const region = regionMap[v] || '首都圏';

                                            // 1. 地方を選択 (通常一番左のカラム)
                                            const regionCol = cols[0] || modal;
                                            const regItem = findInColumn(regionCol, region);
                                            if (regItem) {
                                                regItem.click();
                                                await sleep(1500); // 描画待ちを長めに
                                            }

                                            // 2. 都道府県を選択 (通常真ん中のカラム)
                                            const prefIdMap = { '東京都': '13', '神奈川県': '14', '埼玉県': '11', '千葉県': '12', '大阪府': '27', '愛知県': '23', '福岡県': '40', '北海道': '01' };
                                            const targetId = prefIdMap[v];

                                            const prefCol = cols.length > 1 ? cols[1] : modal;
                                            let prefInput = targetId ? prefCol.querySelector(`#prefecture_${targetId}`) : null;

                                            if (!prefInput) {
                                                const prefLabel = findInColumn(prefCol, v);
                                                prefInput = prefLabel?.querySelector('input[type="checkbox"]') || prefLabel?.parentElement?.querySelector('input[type="checkbox"]');
                                                if (!prefInput && prefLabel) { prefLabel.click(); return 'ok'; }
                                            }

                                            if (prefInput) {
                                                if (!prefInput.checked) prefInput.click();
                                                return 'ok';
                                            }
                                            return 'prefecture_not_found';

                                        } else if (l === '職種') {
                                            // 1. 分類を選択 (通常左のカラム)
                                            const catCol = cols[0] || modal;
                                            let catItem = findInColumn(catCol, v);

                                            if (!catItem && (v.includes('エンジニア') || v.includes('IT'))) {
                                                catItem = findInColumn(catCol, 'ITエンジニア') || findInColumn(catCol, 'エンジニア');
                                            }

                                            if (catItem) {
                                                catItem.click();
                                                await sleep(1500); // 描画待ち
                                            }

                                            // 2. 詳細を選択 (通常右のカラム)
                                            const jobCol = cols.length > 1 ? cols[cols.length - 1] : modal;

                                            // 「すべて選択」があればそれを優先
                                            const allBtn = Array.from(modal.querySelectorAll('button, span, div')).find(el => el.innerText?.trim() === 'すべて選択');
                                            if (allBtn) {
                                                allBtn.click();
                                                return 'ok';
                                            }

                                            const subItem = findInColumn(jobCol, v);
                                            if (subItem) {
                                                const cb = subItem.querySelector('input[type="checkbox"]') || subItem.parentElement.querySelector('input[type="checkbox"]');
                                                if (cb) { if (!cb.checked) cb.click(); }
                                                else subItem.click();
                                                return 'ok';
                                            }
                                            return 'item_not_found';
                                        }
                                        return 'unhandled';
                                    }, { l: label, v: value });


                                    if (selectResult !== 'ok') {
                                        send({ type: 'log', message: `Jobins: ${label}「${value}」を選択できませんでした (${selectResult})。`, level: 'warning' });
                                    }

                                    await page.evaluate(() => {
                                        const btns = Array.from(document.querySelectorAll('button'));
                                        const applyBtn = btns.find(b => b.innerText.includes('この条件を反映する') || b.innerText.includes('反映する') || b.innerText.includes('確定'));
                                        if (applyBtn) applyBtn.click();
                                    });
                                    await page.waitForTimeout(2000);
                                } catch (e) {
                                    send({ type: 'log', message: `Jobins: ${label}設定中にエラー: ${e.message}`, level: 'warning' });
                                }
                            };
                            if (jobCategory) await applyJoBinsFilter('職種', jobCategory);
                            if (location) await applyJoBinsFilter('勤務地', location);

                        }

                        if (db === 'careerbank') {
                            if (location) await page.selectOption(config.searchSelectors.industry, { label: new RegExp(location) }).catch(() => { });
                            if (jobCategory) {
                                await page.evaluate((t) => {
                                    const match = Array.from(document.querySelectorAll('.feas_clevel_01, .feas_clevel_02, label')).find(l => (l.innerText || "").includes(t));
                                    const input = match?.querySelector('input') || match?.parentElement?.querySelector('input');
                                    if (input && !input.checked) input.click();
                                }, jobCategory);
                            }
                        }

                        if (db === 'jobmiru') {
                            try {
                                await page.evaluate(() => {
                                    const labels = Array.from(document.querySelectorAll('label'));
                                    const andLabel = labels.find(l => (l.innerText?.trim() || "") === 'AND' || (l.innerText || "").includes('AND'));
                                    if (andLabel) {
                                        const input = andLabel.querySelector('input') || andLabel.previousElementSibling;
                                        if (input) input.click();
                                    }
                                });
                            } catch (e) { }

                            if (minSalary) {
                                try {
                                    send({ type: 'log', message: `Jobmiru: 最低年収「${minSalary}万円」をセット中...`, level: 'info' });
                                    await page.evaluate((val) => {
                                        const labels = Array.from(document.querySelectorAll('label, span, div'));
                                        const salaryLabel = labels.find(l => (l.innerText?.trim() || "").includes('年収'));
                                        const input = salaryLabel?.querySelector('input, select') || salaryLabel?.nextElementSibling?.querySelector('input, select') || document.querySelector('input.is-select, select.is-select');
                                        if (input) {
                                            input.value = val;
                                            input.dispatchEvent(new Event('input', { bubbles: true }));
                                            input.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    }, minSalary);
                                    await page.waitForTimeout(1000);
                                } catch (e) { }
                            }

                            if (jobCategory) {
                                send({ type: 'log', message: `Jobmiru: 職種「${jobCategory}」をセット中...`, level: 'info' });
                                const catInput = await page.$(config.searchSelectors.jobCategory);
                                if (catInput) {
                                    await catInput.focus();
                                    await catInput.fill(jobCategory);
                                    await page.waitForTimeout(2000);
                                    await page.evaluate(() => {
                                        const list = document.querySelector('ul[role="listbox"], .dropdown-content, [class*="listbox"]');
                                        const first = list?.querySelector('li, div[role="option"], [class*="item"]');
                                        if (first) first.click();
                                    });
                                    await page.waitForTimeout(2000);
                                }
                            }
                        }

                        // キーワード入力 & 検索
                        send({ type: 'log', message: `${db} で検索を実行中...`, level: 'info' });
                        if (searchBox && query) {
                            await searchBox.focus();
                            await searchBox.click({ clickCount: 3 });
                            await page.keyboard.press('Backspace');

                            if (db === 'jobins') {
                                const kws = query.split(/[,，\s]+/).filter(k => k.trim());
                                for (const kw of kws) {
                                    await page.keyboard.type(kw, { delay: 50 });
                                    await page.keyboard.press('Enter');
                                    await page.waitForTimeout(500);
                                }
                            } else {
                                // Jobmiruなどは1つの箱にスペース区切りで入力することを想定
                                await page.keyboard.type(query, { delay: 50 });
                                await page.keyboard.press('Enter');
                            }
                            await page.waitForTimeout(2000);
                        }

                        const yellowBtn = page.locator('button:has-text("件を検索"), .jb-bg-agent-primary').last();
                        if (await yellowBtn.isVisible()) {
                            await yellowBtn.click({ force: true });
                        } else {
                            await page.keyboard.press('Enter');
                        }

                        await page.waitForTimeout(10000);
                        await page.waitForSelector('.jb-shadow, .jb-job-card, .feas_job_list_item, 求人ID, tr.grid, tbody tr', { timeout: 15000 }).catch(() => { });

                    } catch (e) {
                        send({ type: 'log', message: `${db} 検索準備エラー: ${e.message}`, level: 'warning' });
                    }

                    const currentUrlFinal = page.url();
                    if (currentUrlFinal.includes('login')) {
                        send({ type: 'log', message: `${db}: ログインが必要です。`, level: 'warning' });
                        continue;
                    }

                    send({ type: 'log', message: `${db} から求人を抽出しています...`, level: 'info' });
                    await page.keyboard.press('Escape');

                    // 20件程度確保するために複数回スクロール
                    for (let i = 0; i < 3; i++) {
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await page.waitForTimeout(2000);
                        let count = await page.evaluate((sel) => document.querySelectorAll(sel).length, config.selectors.item);
                        if (count >= 20) break;
                    }
                    await page.keyboard.press('Escape');

                    let extracted = await extractJobsFromPage(page, config, db);
                    // 重複排除
                    extracted = extracted.filter((v, i, a) => a.findIndex(t => (t.url === v.url && t.title === v.title)) === i);

                    if (extracted.length > 0) {
                        send({ type: 'log', message: `${db}: ${extracted.length}件を解析中 (上位20件)...`, level: 'info' });
                        for (const job of extracted.slice(0, 20)) {
                            try {
                                let detailPage = null;
                                if (db === 'jobins' && job.url.includes('click_index')) {
                                    const idx = parseInt(job.url.split('=').pop());
                                    send({ type: 'log', message: `解析中: ${job.title.substring(0, 30)}...`, level: 'info' });

                                    const pagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
                                    await page.evaluate((i) => {
                                        const items = Array.from(document.querySelectorAll('[class*="jb-shadow"], [class*="jb-border"], .job-card')).filter(el => {
                                            const isPopup = el.closest('header, [class*="popover"], [class*="Notification"], [class*="dropdown"]');
                                            const text = el.innerText || "";
                                            return text.includes('求人ID') && !isPopup && !text.includes('通知') && !text.includes('お知らせ');
                                        });
                                        const target = items[i];
                                        if (target) {
                                            const link = target.querySelector('a, h4, [class*="jb-text-agent-secondary"]') || target;
                                            link.scrollIntoView();
                                            link.click();
                                        }
                                    }, idx);

                                    detailPage = await pagePromise;
                                    if (!detailPage) {
                                        detailPage = page;
                                        // 既に詳細画面にいる場合は検索画面に戻る必要がある（2件目以降）
                                        if (detailPage.url().includes('/job/detail/') || detailPage.url().includes('click_index')) {
                                            // 自画面で開いた可能性があるためそのまま続行
                                        } else {
                                            send({ type: 'log', message: `詳細画面が開きませんでした。スキップします。`, level: 'warning' });
                                            continue;
                                        }
                                    } else {
                                        await detailPage.bringToFront().catch(() => { });
                                    }
                                } else {
                                    detailPage = await context.newPage();
                                    await detailPage.goto(job.url, { waitUntil: 'load', timeout: 30000 }).catch(() => { });
                                }

                                if (detailPage) {
                                    await detailPage.waitForTimeout(5000); // 描画待ち
                                    const details = await extractJobDetails(detailPage, db);
                                    const jobId = 'job_' + Math.random().toString(36).substr(2, 9);

                                    // JoBinsなどでプレースホルダURL（click_index=等）を使っている場合、
                                    // 実際に開いた詳細画面のURLで上書きする
                                    const actualUrl = detailPage.url();
                                    const jobWithDetail = {
                                        ...job,
                                        id: jobId,
                                        detail: details,
                                        url: (actualUrl && actualUrl !== 'about:blank') ? actualUrl : job.url
                                    };

                                    // 条件合致チェックを実行
                                    const matchResult = checkJobMatch(jobWithDetail, { query, location, minSalary });

                                    if (matchResult.match) {
                                        console.log(`Sending job: ${job.title}`);
                                        send({ type: 'job', job: jobWithDetail });
                                        send({ type: 'log', message: `★条件に合致: ${job.title.substring(0, 20)}...`, level: 'success' });
                                    } else {
                                        send({ type: 'log', message: `不一致によりスキップ: ${job.title.substring(0, 15)}... (${matchResult.reason})`, level: 'info' });
                                    }

                                    if (detailPage !== page) {
                                        await detailPage.close().catch(() => { });
                                    } else if (db === 'jobins') {
                                        await detailPage.goBack({ waitUntil: 'load' }).catch(() => { });
                                        await page.waitForTimeout(2000);
                                    }
                                }
                            } catch (e) {
                                send({ type: 'log', message: `解析エラー (${job.title.substring(0, 15)}): ${e.message}`, level: 'warning' });
                            }
                        }
                    }
                    send({ type: 'log', message: `${db} の解析（${extracted.length}件）が完了しました。`, level: 'success' });
                }
            } catch (err) {
                send({ type: 'log', message: `${db} エラー: ${err.message}`, level: 'error' });
            } finally {
                await page.close();
            }
        }
        send({ type: 'complete' });
    } catch (error) {
        send({ type: 'log', message: `システムエラー: ${error.message}`, level: 'error' });
    } finally {
        res.end();
    }
});

const extractJobDetails = async (page, src) => {
    if (src === 'jobins') {
        try {
            await page.evaluate(() => {
                // 「求人内容」タブがアクティブであることを確認
                const tabs = Array.from(document.querySelectorAll('button, [role="tab"]'));
                const contentTab = tabs.find(t => t.innerText?.includes('求人内容'));
                if (contentTab) contentTab.click();

                // アコーディオンをすべて開く (Radix UI対応)
                const triggers = document.querySelectorAll('[id^="radix-"][aria-expanded="false"]');
                triggers.forEach(t => t.click());
            });
            await page.waitForTimeout(1500);
        } catch (e) { }
    }

    return await page.evaluate((source) => {
        const data = { description: '情報なし', requirements: '情報なし', conditions: '情報なし', process: '情報なし' };

        // 1. メインの求人票エリアを特定 (サイドバーの「目次」を除外するため)
        const mainArea = Array.from(document.querySelectorAll('div[class*="jb-bg-white"], main, article, [role="tabpanel"]'))
            .filter(el => el.innerText?.length > 400)
            .sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;

        const findContent = (keywords) => {
            // A. キーワードを含むラベル・ヘッダーを探す
            const allElements = Array.from(mainArea.querySelectorAll('div, span, h1, h2, h3, h4, h5, dt, th, b, strong, [class*="font-bold"]'));
            const header = allElements.find(el => {
                const t = (el.innerText || "").trim();
                return keywords.some(k => t === k || t === k + ":" || t === k + "：");
            });

            if (!header) {
                // 部分一致で再探索
                const partialHeader = allElements.find(el => {
                    const t = (el.innerText || "").trim();
                    return t.length < 15 && keywords.some(k => t.includes(k));
                });
                if (!partialHeader) return null;
                return partialHeader;
            }
            return header;
        };

        const extractValue = (header) => {
            if (!header) return '情報なし';

            // 1. Radix UI アコーディオン対応: trigger に対応する region を探す
            const id = header.id || header.getAttribute('aria-labelledby');
            if (id) {
                const region = document.querySelector(`[aria-labelledby="${id}"], [id="${id}"] + div, [role="region"]`);
                if (region && region.innerText.length > 20) return region.innerText.trim();
            }

            // 2. 兄弟要素または親の次の要素を探索
            let current = header;
            for (let i = 0; i < 4; i++) {
                let next = current.nextElementSibling;
                while (next) {
                    const t = (next.innerText || "").trim();
                    if (t.length > 20) return t;
                    next = next.nextElementSibling;
                }
                current = current.parentElement;
                if (!current || current === document.body) break;
            }
            return '情報なし';
        };

        if (source === 'jobins') {
            const descH = findContent(['仕事内容', '職務内容', '業務内容', '求人概要', '募集背景']);
            data.description = extractValue(descH);

            const reqH = findContent(['応募条件', '応募資格', '必須要件', '求める人物像', '対象となる方', '必須スキル']);
            data.requirements = extractValue(reqH);

            const condH = findContent(['給与', '福利厚生', '待遇', '休日・休暇', '勤務時間', '諸手当']);
            data.conditions = extractValue(condH);

            const procH = findContent(['選考プロセス', '採用フロー', '選考の流れ']);
            data.process = extractValue(procH);

            // 最終手段: 全文から推測（どこにも入らなかった場合）
            if (data.description === '情報なし' && mainArea.innerText.length > 200) {
                data.description = mainArea.innerText.substring(0, 500) + "...";
            }
        } else if (source === 'careerbank') {
            const h = (k) => findContent(k);
            data.description = extractValue(h(['仕事内容', '職務概要']));
            data.requirements = extractValue(h(['応募資格', '求める経験', 'スキル']));
            data.conditions = extractValue(h(['給与', '福利厚生', '諸手当', '想定勤務地']));
            data.process = extractValue(h(['選考内容', '選考プロセス', '採用の流れ']));
        } else {
            // ... (既存の他サイトロジック) ...
            const h = (k) => findContent(k);
            data.description = extractValue(h(['職務内容', '仕事内容', '業務内容']));
            data.requirements = extractValue(h(['応募資格', '必須要件', 'スキル']));
            data.conditions = extractValue(h(['勤務条件', '福利厚生', '年収']));
            data.process = extractValue(h(['選考プロセス', '採用の流れ']));
        }

        return data;
    }, src);
};

app.post('/api/download-pdf', async (req, res) => {
    const { url, source, title } = req.body;
    let page = null;
    try {
        const context = await getPersistentContext();
        page = await context.newPage();

        // ダウンロードイベントを待機
        const downloadPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null);

        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(3000);

        if (source === 'jobmiru') {
            // 三点リーダーメニューをクリック
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, div, span'));
                const moreBtn = btns.find(b => b.innerText?.trim() === '...' || b.querySelector('svg[class*="DotsHorizontal"]'));
                if (moreBtn) moreBtn.click();
            });
            await page.waitForTimeout(1000);
            // 「PDF で出力」をクリック
            await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('div, span, button, a'));
                const pdfBtn = items.find(i => i.innerText?.includes('PDF で出力'));
                if (pdfBtn) pdfBtn.click();
            });
        }
        else if (source === 'jobins') {
            // 「ダウンロード」ボタンをクリック
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const dlBtn = btns.find(b => b.innerText?.includes('ダウンロード'));
                if (dlBtn) dlBtn.click();
            });
            await page.waitForTimeout(1000);
            // 「求人票(候補者向け)」をクリック
            await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('div, span, a, li'));
                const target = items.find(i => i.innerText?.includes('求人票') && i.innerText?.includes('候補者向け'));
                if (target) target.click();
            });
        }
        else if (source === 'careerbank') {
            // 「求人票(求職者用)を印刷する」をクリック
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const printBtn = btns.find(b => b.innerText?.includes('求人票') && b.innerText?.includes('印刷'));
                if (printBtn) printBtn.click();
            });
        }

        const download = await downloadPromise;
        if (download) {
            const path = await download.path();
            const fileName = await download.suggestedFilename();
            res.download(path, fileName);
        } else {
            // ダウンロードが発生しなかった場合（Window.printなどの可能性）は自力で作成を試みる
            const pdf = await page.pdf({ format: 'A4', printBackground: true });
            res.contentType('application/pdf');
            res.send(pdf);
        }

    } catch (e) {
        console.error('PDF Download Error:', e);
        res.status(500).send({ error: e.message });
    } finally {
        if (page) await page.close().catch(() => { });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
