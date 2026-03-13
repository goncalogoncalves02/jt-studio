import { Helmet } from "react-helmet-async";
import { useLocation } from "react-router-dom";

const SEO = ({ title, description, image, url }) => {
  const { pathname } = useLocation();
  const siteTitle = "JT Studio | Micropigmentação & Estética";
  const defaultDescription =
    "Realce a sua beleza natural com Microblading, Nanoblading e Estética Avançada no JT Studio em Setúbal. Agende já a sua sessão.";
  const siteUrl = "https://jaquelinetakiutistudio.com";
  const defaultImage = `${siteUrl}/og-image.png`;
  const canonicalUrl = url || `${siteUrl}${pathname === "/" ? "" : pathname}`;
  const pageTitle = title ? `${title} | JT Studio` : siteTitle;

  const businessSchema = {
    "@context": "https://schema.org",
    "@type": "BeautySalon",
    name: "Jaqueline Takiuti Studio",
    alternateName: "JT Studio",
    url: siteUrl,
    logo: `${siteUrl}/favicon.png`,
    image: defaultImage,
    description:
      "Realce a sua beleza natural com Microblading, Nanoblading e Estética Avançada no JT Studio em Setúbal.",
    telephone: "+351962149209",
    address: {
      "@type": "PostalAddress",
      streetAddress: "Estrada das Machadas, nº 3C",
      addressLocality: "Setúbal",
      postalCode: "2900-466",
      addressCountry: "PT",
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: 38.532176,
      longitude: -8.898165,
    },
    sameAs: ["https://www.instagram.com/jtmicroblading/"],
    priceRange: "€€",
    areaServed: {
      "@type": "City",
      name: "Setúbal",
    },
  };

  const breadcrumbSchema =
    pathname !== "/"
      ? {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Home",
              item: siteUrl,
            },
            {
              "@type": "ListItem",
              position: 2,
              name: title || "Página",
              item: canonicalUrl,
            },
          ],
        }
      : null;

  const websiteSchema =
    pathname === "/"
      ? {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "JT Studio",
          url: siteUrl,
          inLanguage: "pt-PT",
        }
      : null;

  return (
    <Helmet>
      <title>{pageTitle}</title>
      <meta name="description" content={description || defaultDescription} />
      <link rel="canonical" href={canonicalUrl} />

      {/* Localização e Autor */}
      <meta name="author" content="Jaqueline Takiuti Studio" />
      <meta name="geo.region" content="PT-15" />
      <meta name="geo.placename" content="Setúbal" />
      <meta name="geo.position" content="38.532176;-8.898165" />
      <meta name="ICBM" content="38.532176, -8.898165" />
      <meta name="theme-color" content="#be185d" />

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:title" content={pageTitle} />
      <meta
        property="og:description"
        content={description || defaultDescription}
      />
      <meta property="og:image" content={image || defaultImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:locale" content="pt_PT" />
      <meta property="og:site_name" content="JT Studio" />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={pageTitle} />
      <meta
        name="twitter:description"
        content={description || defaultDescription}
      />
      <meta name="twitter:image" content={image || defaultImage} />

      {/* Structured Data */}
      <script type="application/ld+json">
        {JSON.stringify(businessSchema)}
      </script>
      {breadcrumbSchema && (
        <script type="application/ld+json">
          {JSON.stringify(breadcrumbSchema)}
        </script>
      )}
      {websiteSchema && (
        <script type="application/ld+json">
          {JSON.stringify(websiteSchema)}
        </script>
      )}
    </Helmet>
  );
};

export default SEO;
