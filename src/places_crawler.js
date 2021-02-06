/* eslint-env jquery */
const Apify = require('apify');
const Globalize = require('globalize');

const typedefs = require('./typedefs'); // eslint-disable-line no-unused-vars
const Stats = require('./stats'); // eslint-disable-line no-unused-vars
const ErrorSnapshotter = require('./error-snapshotter'); // eslint-disable-line no-unused-vars

const { enqueueAllPlaceDetails } = require('./enqueue_places');
const { handlePlaceDetail } = require('./detail_page_handle');
const {
    waitAndHandleConsentFrame, waiter,
} = require('./utils');

const { log } = Apify.utils;
const { injectJQuery, blockRequests } = Apify.utils.puppeteer;

// TODO: Instead of loading default ones, it should load the specific provided language
const DEFAULT_CRAWLER_LOCALIZATION = ['en', 'cs', 'es', 'fr'];

Globalize.load(require('cldr-data').entireSupplemental());
Globalize.load(require('cldr-data').entireMainFor(...DEFAULT_CRAWLER_LOCALIZATION));

/**
 * @param {{
 *  scrapingOptions: typedefs.ScrapingOptions,
 *  crawlerOptions: typedefs.CrawlerOptions,
 *  stats: Stats,
 *  errorSnapshotter: ErrorSnapshotter,
 *  pageContext: Apify.PuppeteerHandlePageInputs,
 * }} options
 */
const handlePageFunctionExtended = async ({ pageContext, scrapingOptions, crawlerOptions, stats, errorSnapshotter }) => {
    const { request, page, puppeteerPool, session, autoscaledPool } = pageContext;
    const { maxCrawledPlaces, multiplier } = scrapingOptions;
    const { requestQueue } = crawlerOptions;

    const { label, searchString } = /** @type {{ label: string, searchString: string }} */ (request.userData);

    await injectJQuery(page);

    const logLabel = label === 'startUrl' ? 'SEARCH' : 'PLACE';

    // Handle consent screen, this wait is ok because we wait for selector later anyway
    await page.waitForTimeout(5000);
    // @ts-ignore I'm not sure how we could fix the types here
    if (request.userData.waitingForConsent !== undefined) {
        // @ts-ignore  I'm not sure how we could fix the types here
        await waiter(() => request.userData.waitingForConsent === false);
    }

    try {
        // Check if Google shows captcha
        if (await page.$('form#captcha-form')) {
            throw `[${logLabel}]: Got CAPTCHA on page, retrying --- ${searchString || ''} ${request.url}`;
        }
        if (label === 'startUrl') {
            log.info(`[${logLabel}]: Start enqueuing places details for search --- ${searchString || ''} ${request.url}`);
            await errorSnapshotter.tryWithSnapshot(
                page,
                async () => enqueueAllPlaceDetails({
                    page,
                    searchString,
                    requestQueue,
                    request,
                    stats,
                    scrapingOptions,
                }),
            );

            log.info(`[${logLabel}]: Enqueuing places finished for --- ${searchString || ''} ${request.url}`);
            stats.maps();
        } else {
            // Get data for place and save it to dataset
            log.info(`[${logLabel}]: Extracting details from place url ${page.url()}`);

            await handlePlaceDetail({
                page,
                request,
                searchString,
                // @ts-ignore
                session,
                scrapingOptions,
                errorSnapshotter,
                stats,
            });

            // TODO: Rework this terrible thing :)
            // when using polygon search multiple start urls are used. Therefore more links are added to request queue,
            // there is also good possibility that some of places will be out of desired polygon, so we do not check number of queued places,
            // only number of places with correct geolocation
            if (maxCrawledPlaces && maxCrawledPlaces !== 0) {
                const dataset = await Apify.openDataset();
                // @ts-ignore
                const { cleanItemCount } = await dataset.getInfo();
                if (cleanItemCount >= maxCrawledPlaces * multiplier) {
                    await autoscaledPool.abort();
                }
            }
        }
        stats.ok();
    } catch (err) {
        session.retire();
        await puppeteerPool.retire(page.browser());
        throw err;
    }
};

/**
 * Setting up PuppeteerCrawler
 * @param {{
 *  crawlerOptions: typedefs.CrawlerOptions,
 *  scrapingOptions: typedefs.ScrapingOptions,
 *  stats: Stats,
 *  errorSnapshotter: ErrorSnapshotter,
 * }} options
 */
const setUpCrawler = ({ crawlerOptions, scrapingOptions, stats, errorSnapshotter }) => {
    const { maxImages, language } = scrapingOptions;
    const { pageLoadTimeoutSec, ...options } = crawlerOptions;
    return new Apify.PuppeteerCrawler({
        // We have to strip this otherwise SDK complains
        ...options,
        gotoFunction: async ({ request, page }) => {
            // @ts-ignore
            // eslint-disable-next-line no-underscore-dangle
            await page._client.send('Emulation.clearDeviceMetricsOverride');
            // This blocks images so we have to skip it
            if (!maxImages) {
                await blockRequests(page, {
                    urlPatterns: ['/maps/vt/', '/earth/BulkMetadata/', 'googleusercontent.com'],
                });
            }
            const mapUrl = new URL(request.url);

            if (language) {
                mapUrl.searchParams.set('hl', language);
            }

            request.url = mapUrl.toString();

            await page.setViewport({ width: 800, height: 800 });

            // Handle consent screen, it takes time before the iframe loads so we need to update userData
            // and block handlePageFunction from continuing until we click on that
            page.on('response', async (res) => {
                if (res.url().includes('consent.google.com/intro')) {
                    // @ts-ignore
                    request.userData.waitingForConsent = true;
                    await page.waitForTimeout(5000);
                    await waitAndHandleConsentFrame(page, request.url);
                    // @ts-ignore
                    request.userData.waitingForConsent = false;
                }
            });
            const result = await page.goto(request.url, { timeout: pageLoadTimeoutSec * 1000 });

            return result;
        },
        handlePageFunction: async (pageContext) => {
            await errorSnapshotter.tryWithSnapshot(
                pageContext.page,
                async () => handlePageFunctionExtended({ pageContext, scrapingOptions, crawlerOptions, stats, errorSnapshotter }),
            );
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            // This function is called when crawling of a request failed too many time
            stats.failed();
            const defaultStore = await Apify.openKeyValueStore();
            await Apify.pushData({
                '#url': request.url,
                '#succeeded': false,
                '#errors': request.errorMessages,
                '#debugInfo': Apify.utils.createRequestDebugInfo(request),
                '#debugFiles': {
                    html: defaultStore.getPublicUrl(`${request.id}.html`),
                    screen: defaultStore.getPublicUrl(`${request.id}.png`),
                },
            });
            log.exception(error, `Page ${request.url} failed ${request.retryCount + 1} `
                + 'times! It will not be retired. Check debug fields in dataset to find the issue.');
        },
    });
};

module.exports = { setUpCrawler };
