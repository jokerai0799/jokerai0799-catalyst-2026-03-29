export const config = {
  matcher: ['/'],
};

export default function middleware(request) {
  const url = new URL(request.url);

  const hasTrackedHomepageParams = Array.from(url.searchParams.keys()).some((key) =>
    key.toLowerCase().startsWith('utm_')
  );

  if (hasTrackedHomepageParams) {
    url.search = '';
    return Response.redirect(url, 308);
  }
}
