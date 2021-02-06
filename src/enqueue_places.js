/* eslint-env jquery */
const Apify = require('apify');
const querystring = require('querystring');

const Puppeteer = require('puppeteer'); // eslint-disable-line
const typedefs = require('./typedefs'); // eslint-disable-line no-unused-vars
const Stats = require('./stats'); // eslint-disable-line no-unused-vars

const { sleep, log } = Apify.utils;
const { DEFAULT_TIMEOUT, LISTING_PAGINATION_KEY, PLACE_TITLE_SEL } = require('./consts');
const { waitForGoogleMapLoader, parseSearchPlacesResponseBody, parseZoomFromUrl } = require('./utils');
const { checkInPolygon } = require('./polygon');

/**
 * This handler waiting for response from xhr and enqueue places from the search response boddy.
 * @param {{
 *   page: Puppeteer.Page,
 *   requestQueue: Apify.RequestQueue,
 *   searchString: string,
 *   maxPlacesPerCrawl: number | undefined,
 *   exportPlaceUrls: boolean,
 *   geo: object,
 *   placesCache: PlacesCache,
 *   stats: Stats,
 * }} options
 * @return {(response: Puppeteer.Response) => Promise<void>}
 */
const enqueuePlacesFromResponse = (options) => {
    const { page, requestQueue, searchString, maxPlacesPerCrawl, exportPlaceUrls, geo, placesCache, stats } = options;
    return async (response) => {
        const url = response.url();
        if (url.startsWith('https://www.google.com/search')) {
            // Parse page number from request url
            const queryParams = querystring.parse(url.split('?')[1]);
            // @ts-ignore
            const pageNumber = parseInt(queryParams.ech, 10);
            // Parse place ids from response body
            const responseBody = await response.buffer();
            const placesPaginationData = parseSearchPlacesResponseBody(responseBody);
            let index = -1;
            let enqueued = 0;
            // At this point, page URL should be resolved
            const searchPageUrl = page.url();

            for (const placePaginationData of placesPaginationData) {
                index++;
                const rank = ((pageNumber - 1) * 20) + (index + 1);
                if (!maxPlacesPerCrawl || rank <= maxPlacesPerCrawl) {
                    if (exportPlaceUrls) {
                        await Apify.pushData({
                            url: `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placePaginationData.placeId}`,
                        });
                    } else {
                        // TODO: Refactor this once we get rid of the caching
                        const coordinates = placePaginationData.coords || placesCache.getLocation(placePaginationData.placeId);
                        const placeUrl = `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placePaginationData.placeId}`;
                        placesCache.addLocation(placePaginationData.placeId, coordinates, searchString);
                        if (!geo || !coordinates || checkInPolygon(geo, coordinates)) {
                            await requestQueue.addRequest({
                                    url: placeUrl,
                                    uniqueKey: placePaginationData.placeId,
                                    userData: {
                                        label: 'detail',
                                        searchString,
                                        rank,
                                        searchPageUrl,
                                        coords: placePaginationData.coords,
                                        addressParsed: placePaginationData.addressParsed,
                                        isAdvertisement: placePaginationData.isAdvertisement,
                                    },
                                },
                                { forefront: true });
                            enqueued++;
                        } else {
                            stats.outOfPolygonCached();
                            stats.outOfPolygon();
                            stats.addOutOfPolygonPlace({ url: placeUrl, searchPageUrl, coordinates });
                        }
                    }
                }
            }
            const numberOfAds = placesPaginationData.filter((item) => item.isAdvertisement).length;
            log.info(`[SEARCH]: Enqueued ${enqueued}/${placesPaginationData.length} places (correct location/total) + ${numberOfAds} ads --- ${page.url()}`)
        }
    };
};

/**
 * Method adds places from listing to queue
 * @param {{
 *  page: Puppeteer.Page,
 *  searchString: string,
 *  requestQueue: Apify.RequestQueue,
 *  request: Apify.Request,
 *  stats: Stats,
 *  scrapingOptions: typedefs.ScrapingOptions,
 * }} options
 */
const enqueueAllPlaceDetails = async ({
                                          page,
                                          searchString,
                                          requestQueue,
                                          request,
                                          stats,
                                          scrapingOptions,
                                      }) => {
    const { geo, maxAutomaticZoomOut, placesCache, exportPlaceUrls, maxCrawledPlaces } = scrapingOptions;
    page.on('response', enqueuePlacesFromResponse({
        page,
        requestQueue,
        searchString,
        maxPlacesPerCrawl: maxCrawledPlaces,
        exportPlaceUrls,
        geo,
        placesCache,
        stats,
    }));
    // Save state of listing pagination
    // NOTE: If pageFunction failed crawler skipped already scraped pagination
    const listingStateKey = `${LISTING_PAGINATION_KEY}-${request.id}`;

    /** @typedef {{ from: number, to: number, isFinish: boolean }} ListingPagination */
    const listingPagination = /** @type ListingPagination */ (await Apify.getValue(listingStateKey)) || {};

    // there is no searchString when startUrls are used
    if (searchString) {
        await page.waitForSelector('#searchboxinput', { timeout: 15000 });
        await page.type('#searchboxinput', searchString);
    }

    await sleep(5000);
    await page.click('#searchbox-searchbutton');
    await sleep(5000);
    await waitForGoogleMapLoader(page);
    try {
        // This might no longer work and I don't know why it is here. I reduced timeout to 5000 at least (LK)
        await page.waitForSelector(PLACE_TITLE_SEL, { timeout: 5000 });
        // It there is place detail, it means there is just one detail and it was redirected here.
        // We do not need enqueue other places.
        log.debug(`[SEARCH]: Search string ${searchString} has just one place to scraper.`);
        return;
    } catch (e) {
        // It can happen if there is list of details.
    }

    const startZoom = /** @type {number} */ (parseZoomFromUrl(page.url()));

    // In case there is a list of details, it goes through details, limits by maxPlacesPerCrawl
    const nextButtonSelector = '[jsaction="pane.paginationSection.nextPage"]';
    for (; ;) {
        await page.waitForSelector(nextButtonSelector, { timeout: DEFAULT_TIMEOUT });
        // @ts-ignore
        const paginationText = await page.$eval('.n7lv7yjyC35__root', (el) => el.innerText);
        const [fromString, toString] = paginationText.match(/\d+/g);
        const from = parseInt(fromString, 10);
        const to = parseInt(toString, 10);
        log.debug(`[SEARCH]: Added links from pagination ${from} - ${to}`);
        listingPagination.from = from;
        listingPagination.to = to;
        await Apify.setValue(listingStateKey, listingPagination);
        await page.waitForSelector(nextButtonSelector, { timeout: DEFAULT_TIMEOUT });
        const isNextPaginationDisabled = await page.evaluate((nextButtonSel) => {
            return !!$(nextButtonSel).attr('disabled');
        }, nextButtonSelector);
        const noResultsEl = await page.$('.section-no-result-title');

        // If Google auto-zoomes too far, we might want to end the search
        let finishBecauseAutoZoom = false;
        if (typeof maxAutomaticZoomOut === 'number') {
            const actualZoom = /** @type {number} */ (parseZoomFromUrl(page.url()));
            // console.log('ACTUAL ZOOM:', actualZoom, 'STARTED ZOOM:', startZoom);
            const googleZoomedOut = startZoom - actualZoom;
            if (googleZoomedOut > maxAutomaticZoomOut) {
                finishBecauseAutoZoom = true;
            }
        }
        if (isNextPaginationDisabled || noResultsEl || (maxCrawledPlaces && maxCrawledPlaces <= to) || finishBecauseAutoZoom) {
            if (isNextPaginationDisabled) {
                log.warning(`[SEARCH]: Finishing search because there are no more pages --- ${searchString} - ${request.url}`);
            } else if (noResultsEl) {
                log.warning(`[SEARCH]: Finishing search because it reached an empty page --- ${searchString} - ${request.url}`);
            } else if (maxCrawledPlaces && maxCrawledPlaces <= to) {
                log.warning(`[SEARCH]: Finishing search because we reached maxCrawledPlaces --- ${searchString} - ${request.url}`);
            } else if (finishBecauseAutoZoom) {
                log.warning('[SEARCH]: Finishing search because Google zoomed out '
                    + 'further than maxAutomaticZoomOut. Current zoom: '
                    + `${parseZoomFromUrl(page.url())} --- ${searchString} - ${request.url}`);
            }
            break;
        } else {
            // NOTE: puppeteer API click() didn't work :|
            await page.evaluate((sel) => $(sel).click(), nextButtonSelector);
            await waitForGoogleMapLoader(page);
        }
    }

    listingPagination.isFinish = true;
    page.removeListener('request', enqueuePlacesFromResponse);
    await Apify.setValue(listingStateKey, listingPagination);
};

module.exports = { enqueueAllPlaceDetails };
