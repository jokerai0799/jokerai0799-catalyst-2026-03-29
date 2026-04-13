export const config = {
  matcher: ['/'],
};

export default function middleware(request) {
  const url = new URL(request.url);

  const hasTrackedHomepageParams =
    url.searchParams.get('utm_source') === 'trustpilot' ||
    url.searchParams.get('utm_medium') === 'company_profile' ||
    url.searchParams.get('utm_campaign') === 'domain_click';

  if (hasTrackedHomepageParams) {
    url.search = '';
    return Response.redirect(url, 308);
  }
}
