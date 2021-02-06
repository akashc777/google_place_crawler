const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line
const Globalize = require('globalize');

const {AddressParsed} = require('./typedefs')

const { PLACE_TITLE_SEL, BACK_BUTTON_SEL } = require('./consts');
const { waitForGoogleMapLoader, parseReviewFromResponseBody, scrollTo, enlargeImageUrls } = require('./utils');
const infiniteScroll = require('./infinite_scroll');

/* eslint-env jquery */
const { log, sleep } = Apify.utils;

/**
 * @param {{
 *    page: Puppeteer.Page,
 *    addressParsed: AddressParsed | undefined,
 * }} options
 */
module.exports.extractPageData = async ({ page, addressParsed }) => {
    return page.evaluate((placeTitleSel, addressParsed) => {
        const address = $('[data-section-id="ad"] .section-info-line').text().trim();
        const addressAlt = $("button[data-tooltip*='address']").text().trim();
        const addressAlt2 = $("button[data-item-id*='address']").text().trim();
        const secondaryAddressLine = $('[data-section-id="ad"] .section-info-secondary-text').text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt = $("button[data-tooltip*='locatedin']").text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt2 = $("button[data-item-id*='locatedin']").text().replace('Located in:', '').trim();
        const phone = $('[data-section-id="pn0"].section-info-speak-numeral').length
            // @ts-ignore
            ? $('[data-section-id="pn0"].section-info-speak-numeral').attr('data-href').replace('tel:', '')
            : $("button[data-tooltip*='phone']").text().trim();
        const phoneAlt = $('button[data-item-id*=phone]').text().trim();
        let temporarilyClosed = false;
        let permanentlyClosed = false;
        const altOpeningHoursText = $('[class*="section-info-hour-text"] [class*="section-info-text"]').text().trim();
        if (altOpeningHoursText === 'Temporarily closed') temporarilyClosed = true;
        else if (altOpeningHoursText === 'Permanently closed') permanentlyClosed = true;

        return {
            title: $(placeTitleSel).text().trim(),
            subTitle: $('section-hero-header-title-subtitle').first().text().trim() || null,
            totalScore: $('span.section-star-display').eq(0).text().trim(),
            categoryName: $('[jsaction="pane.rating.category"]').text().trim(),
            address: address || addressAlt || addressAlt2 || null,
            locatedIn: secondaryAddressLine || secondaryAddressLineAlt || secondaryAddressLineAlt2 || null,
            ...addressParsed || {},
            plusCode: $('[data-section-id="ol"] .widget-pane-link').text().trim()
                || $("button[data-tooltip*='plus code']").text().trim()
                || $("button[data-item-id*='oloc']").text().trim() || null,
            website: $('[data-section-id="ap"]').length
                ? $('[data-section-id="ap"]').eq(0).text().trim()
                : $("button[data-tooltip*='website']").text().trim()
                || $("button[data-item-id*='authority']").text().trim() || null,
            phone: phone || phoneAlt || null,
            temporarilyClosed,
            permanentlyClosed,
        };
    }, PLACE_TITLE_SEL, addressParsed);
};

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
 */
module.exports.extractPopularTimes = async ({ page }) => {
    const output = {};
    // Include live popular times value
    const popularTimesLiveRawValue = await page.evaluate(() => {
        return $('.section-popular-times-live-value').attr('aria-label');
    });
    const popularTimesLiveRawText = await page.evaluate(() => $('.section-popular-times-live-description').text().trim());
    output.popularTimesLiveText = popularTimesLiveRawText;
    const popularTimesLivePercentMatch = popularTimesLiveRawValue ? popularTimesLiveRawValue.match(/(\d+)\s?%/) : null;
    output.popularTimesLivePercent = popularTimesLivePercentMatch ? Number(popularTimesLivePercentMatch[1]) : null;

    const histogramSel = '.section-popular-times';
    if (await page.$(histogramSel)) {
        output.popularTimesHistogram = await page.evaluate(() => {
            /** @type {{[key: string]: any[]}} */
            const graphs = {};
            const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
            // Extract all days graphs
            $('.section-popular-times-graph').each(function (i) {
                const day = days[i];
                graphs[day] = [];

                /** @type {number | undefined} */
                let graphStartFromHour;

                // Finds where x axis starts
                $(this).find('.section-popular-times-label').each(function (labelIndex) {
                    if (graphStartFromHour) return;
                    const hourText = $(this).text().trim();
                    graphStartFromHour = hourText.includes('p')
                        ? 12 + (parseInt(hourText, 10) - labelIndex)
                        : parseInt(hourText, 10) - labelIndex;
                });
                // Finds values from y axis
                $(this).find('.section-popular-times-bar').each(function (barIndex) {
                    // @ts-ignore
                    const occupancyMatch = $(this).attr('aria-label').match(/\d+(\s+)?%/);
                    if (occupancyMatch && occupancyMatch.length) {
                        // @ts-ignore
                        const maybeHour = graphStartFromHour + barIndex;
                        graphs[day].push({
                            hour: maybeHour > 24 ? maybeHour - 24 : maybeHour,
                            occupancyPercent: parseInt(occupancyMatch[0], 10),
                        });
                    }
                });
            });
            return graphs;
        });
    }
    return output;
};

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
 */
module.exports.extractOpeningHours = async ({ page }) => {
    let result;
    const openingHoursSel = '.section-open-hours-container.section-open-hours-container-hoverable';
    const openingHoursSelAlt = '.section-open-hours-container.section-open-hours';
    const openingHoursSelAlt2 = '.section-open-hours-container';
    const openingHoursEl = (await page.$(openingHoursSel)) || (await page.$(openingHoursSelAlt)) || (await page.$(openingHoursSelAlt2));
    if (openingHoursEl) {
        const openingHoursText = await page.evaluate((openingHoursElem) => {
            return openingHoursElem.getAttribute('aria-label');
        }, openingHoursEl);

        /** @type {string[]} */
        const openingHours = openingHoursText.split(openingHoursText.includes(';') ? ';' : ',');
        if (openingHours.length) {
            result = openingHours.map((line) => {
                const regexpResult = line.trim().match(/(\S+)\s(.*)/);
                if (regexpResult) {
                    // eslint-disable-next-line prefer-const
                    let [, day, hours] = regexpResult;
                    ([hours] = hours.split('.'));
                    return { day, hours };
                }
                log.debug(`[PLACE]: Not able to parse opening hours: ${line}`);
            });
        }
    }
    return result;
};

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
 */
module.exports.extractPeopleAlsoSearch = async ({ page }) => {
    const result = [];
    const peopleSearchContainer = await page.$('.section-carousel-scroll-container');
    if (peopleSearchContainer) {
        const cardSel = 'button[class$="card"]';
        const cards = await peopleSearchContainer.$$(cardSel);
        for (let i = 0; i < cards.length; i++) {
            const searchResult = await page.evaluate((index, sel) => {
                const card = $(sel).eq(index);
                return {
                    title: card.find('div[class$="title"]').text().trim(),
                    totalScore: card.find('span[class$="rating"]').text().trim(),
                };
            }, i, cardSel);
            // For some reason, puppeteer click doesn't work here
            await Promise.all([
                page.evaluate((button, index) => {
                    $(button).eq(index).click();
                }, cardSel, i),
                page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'] }),
            ]);
            // @ts-ignore
            searchResult.url = await page.url();
            result.push(searchResult);
            await Promise.all([
                page.goBack({ waitUntil: ['domcontentloaded', 'networkidle2'] }),
                waitForGoogleMapLoader(page),
            ]);
        }
    }
    return result;
};

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
 */
module.exports.extractAdditionalInfo = async ({ page }) => {
    let result;
    log.debug('[PLACE]: Scraping additional info.');
    await page.waitForSelector('button.section-editorial', { timeout: 5000 }).catch(() => {
    });
    const button = await page.$('button.section-editorial');
    if (button) {
        try {
            await button.click({ delay: 200 });
            await page.waitForSelector('.section-attribute-group', { timeout: 30000 });
            result = await page.evaluate(() => {
                /** @type {{[key: string]: any[]}} */
                const innerResult = {};
                $('.section-attribute-group').each((_, section) => {
                    const key = $(section).find('.section-attribute-group-title').text().trim();
                    /** @type {{[key: string]: boolean}[]} */
                    const values = [];
                    $(section).find('.section-attribute-group-container .section-attribute-group-item').each((_i, sub) => {
                        /** @type {{[key: string]: boolean}} */
                        const res = {};
                        const title = $(sub).text().trim();
                        const isChecked = $(sub).find('.section-attribute-group-item-icon').length > 0;
                        // @ts-ignore
                        res[title] = isChecked;
                        values.push(res);
                    });
                    innerResult[key] = values;
                });
                return innerResult;
            });
        } catch (e) {
            log.info(`[PLACE]: ${e}Additional info not parsed`);
        } finally {
            const backButton = await page.$(BACK_BUTTON_SEL);
            if (!backButton) {
                // eslint-disable-next-line no-unsafe-finally
                throw new Error('Back button for additional info is not present');
            }
            await backButton.click({ delay: 200 });
            await page.waitForSelector(PLACE_TITLE_SEL);
        }
    } else {
        log.warning(`Could not find button to get to additional data, skipping - ${page.url()}`);
    }
    return result;
};

/**
 * totalScore is string because it is parsed via localization
 * @param {{
 *    page: Puppeteer.Page,
 *    totalScore: string,
 *    maxReviews: number,
 *    reviewsSort: string,
 *    reviewsTranslation: string,
 * }} options
 */
module.exports.extractReviews = async ({ page, totalScore, maxReviews, reviewsSort, reviewsTranslation }) => {
    const result = {};

    const reviewsButtonSel = 'button[jsaction="pane.reviewChart.moreReviews"]';
    // This selector is not present when there are no reviews
    try {
        await page.waitForSelector(reviewsButtonSel, { timeout: 15000 });
    } catch (e) {
        log.warning(`Could not find reviews count, check if the page really has no reviews --- ${page.url()}`);
    }
    if (totalScore) {
        const { reviewsCountText, localization } = await page.evaluate((selector) => {
            const numberReviewsText = $(selector).text().trim();
            // NOTE: Needs handle:
            // Recenze: 7
            // 1.609 reviews
            // 9 reviews
            const number = numberReviewsText.match(/[.,0-9]+/);
            return {
                reviewsCountText: number ? number[0] : null,
                localization: navigator.language.slice(0, 2),
            };
        }, reviewsButtonSel);
        let globalParser;
        try {
            globalParser = Globalize(localization);
        } catch (e) {
            throw new Error(`[PLACE]: Can not find localization for ${localization}, try to use different proxy IP.`);
        }

        // @ts-ignore
        result.totalScore = globalParser.numberParser({ round: 'floor' })(totalScore);
        result.reviewsCountText = reviewsCountText;
        // @ts-ignore
        result.reviewsCount = reviewsCountText ? globalParser.numberParser({ round: 'truncate' })(reviewsCountText) : null;

        // click the consent iframe, working with arrays so it never fails.
        // also if there's anything wrong with Same-Origin, just delete the modal contents
        // TODO: Why is this isolated in reviews?
        await page.$$eval('#consent-bump iframe', async (frames) => {
            try {
                frames.forEach((frame) => {
                    // @ts-ignore
                    [...frame.contentDocument.querySelectorAll('#introAgreeButton')].forEach((s) => s.click());
                });
            } catch (e) {
                document.querySelectorAll('#consent-bump > *').forEach((el) => el.remove());
            }
        });

        // TODO: Scrape default reviews (will allow us to extract 10 reviews by default without additional clicking)
        if (result.reviewsCount && typeof maxReviews === 'number' && maxReviews > 0) {
            /** @type {object[]} */
            result.reviews = [];
            await page.waitForSelector(reviewsButtonSel);
            await page.click(reviewsButtonSel);

            /** @type {{[key: string]: number}} */
            const reviewSortOptions = {
                mostRelevant: 0,
                newest: 1,
                highestRanking: 2,
                lowestRanking: 3,
            };

            // Set up sort from newest
            const sortPromise1 = async () => {
                try {
                    await page.click('button[data-value="Sort"], [class*=dropdown-icon]');
                    await sleep(1000);
                    for (let i = 0; i < reviewSortOptions[reviewsSort]; i += 1) {
                        await page.keyboard.press('ArrowDown');
                        await sleep(500);
                    }
                    await page.keyboard.press('Enter');
                } catch (e) {
                    log.debug('[PLACE]: Unable to sort reviews!');
                }
            };

            await sleep(5000);
            // eslint-disable-next-line no-unused-vars
            const [reviewsResponse] = await Promise.all([
                page.waitForResponse((response) => response.url().includes('preview/review/listentitiesreviews')),
                sortPromise1(),
                // This is here to work around the default setting not giving us any XHR
                // TODO: Rework this
                scrollTo(page, '.section-scrollbox.scrollable-y', 10000),
            ]);

            const reviewResponseBody = await reviewsResponse.buffer();
            const reviewsFirst = parseReviewFromResponseBody(reviewResponseBody);

            result.reviews.push(...reviewsFirst);
            result.reviews = result.reviews.slice(0, maxReviews);
            log.info(`[PLACE]: Exracting reviews: ${result.reviews.length}/${result.reviewsCount} --- ${page.url()}`);
            let reviewUrl = reviewsResponse.url();

            // TODO: This looks buggy since we want to sort as user inputs, not by newest
            // Replace !3e1 in URL with !3e2, it makes list sort by newest
            reviewUrl = reviewUrl.replace(/!3e\d/, '!3e2');

            // TODO: We capture the first batch, this should not start from 0 I think
            // Make sure that we star review from 0, setting !1i0
            reviewUrl = reviewUrl.replace(/!1i\d+/, '!1i0');

            /** @param {string} url */
            const increaseLimitInUrl = (url) => {
                // @ts-ignore
                const numberString = reviewUrl.match(/!1i(\d+)/)[1];
                const number = parseInt(numberString, 10);
                return url.replace(/!1i\d+/, `!1i${number + 10}`);
            };

            while (result.reviews.length < maxReviews) {
                // Request in browser context to use proxy as in brows
                const responseBody = await page.evaluate(async (url) => {
                    const response = await fetch(url);
                    return response.text();
                }, reviewUrl);
                const reviews = parseReviewFromResponseBody(responseBody, reviewsTranslation);
                if (reviews.length === 0) {
                    break;
                }
                result.reviews.push(...reviews);
                result.reviews = result.reviews.slice(0, maxReviews);
                log.info(`[PLACE]: Exracting reviews: ${result.reviews.length}/${result.reviewsCount} --- ${page.url()}`);
                reviewUrl = increaseLimitInUrl(reviewUrl);
            }
            log.info(`[PLACE]: Reviews extraction finished: ${result.reviews.length}/${result.reviewsCount} --- ${page.url()}`);

            await page.waitForTimeout(500);
            const backButton = await page.$(BACK_BUTTON_SEL);
            if (!backButton) {
                throw new Error('Back button for reviews is not present');
            }
            await backButton.click();
        }
    }
    return result;
};

/**
 * totalScore is string because it is parsed via localization
 * @param {{
 * page: Puppeteer.Page,
 * maxImages: number,
 }} options
 */
module.exports.extractImages = async ({ page, maxImages }) => {
    if (!maxImages || maxImages === 0) {
        return undefined;
    }

    let resultImageUrls;

    const mainImageSel = '.section-hero-header-image-hero-container';
    const mainImage = await page.waitForSelector(mainImageSel);

    if (maxImages === 1) {
        // @ts-ignore
        const imageUrl = await mainImage.$eval('img', (el) => el.src);
        resultImageUrls = [imageUrl];
    }
    if (maxImages > 1) {
        await sleep(2000);
        await mainImage.click();
        let lastImage = null;
        let pageBottom = 10000;
        let imageUrls = [];

        log.info(`[PLACE]: Infinite scroll for images started, url: ${page.url()}`);

        for (; ;) {
            // TODO: Debug infiniteScroll properly, it can get stuck in there sometimes, for now just adding a race
            await Promise.race([
                infiniteScroll(page, pageBottom, '.section-scrollbox.scrollable-y', 1),
                Apify.utils.sleep(20000),
            ]);
            imageUrls = await page.evaluate(() => {
                /** @type {string[]} */
                const urls = [];
                $('.gallery-image-high-res').each(function () {
                    // @ts-ignore
                    const urlMatch = $(this).attr('style').match(/url\("(.*)"\)/);
                    if (!urlMatch) return;
                    let imageUrl = urlMatch[1];
                    if (imageUrl[0] === '/') imageUrl = `https:${imageUrl}`;
                    urls.push(imageUrl);
                });
                return urls;
            });
            if (imageUrls.length >= maxImages || lastImage === imageUrls[imageUrls.length - 1]) {
                log.info(`[PLACE]: Infinite scroll for images finished, url: ${page.url()}`);
                break;
            }
            log.info(`[PLACE]: Infinite scroll continuing for images, currently ${imageUrls.length}, url: ${page.url()}`);
            lastImage = imageUrls[imageUrls.length - 1];
            pageBottom += 6000;
        }
        resultImageUrls = imageUrls.slice(0, maxImages);
    }

    return enlargeImageUrls(resultImageUrls);
};
