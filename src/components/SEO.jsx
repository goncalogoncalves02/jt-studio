import { useContext, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useLocation } from "react-router-dom";
import { safeJson } from "../blog/safe-json.js";
import { HeadDataContext } from "../blog/HeadDataContext.js";

const SEO = ({ title, description, image, imageWidth, imageHeight, url, type = "website", structuredData, noindex = false }) => {
  const { pathname } = useLocation();
  const canonicalPathname = pathname.replace(/\/+$/, "") || "/";
  const siteTitle = "JT Studio | Micropigmentação & Estética";
  const defaultDescription =
    "Micropigmentação, Nanoblading e Estética Avançada no JT Studio em Setúbal. Avaliação 4.9★ no Google. Agende já a sua sessão.";
  const siteUrl = "https://jaquelinetakiutistudio.com";
  const defaultImage = `${siteUrl}/og-image.png`;
  const canonicalUrl = url || `${siteUrl}${canonicalPathname === "/" ? "" : canonicalPathname}`;
  const shouldNoindex = noindex || canonicalPathname === "/admin" || canonicalPathname.startsWith("/admin/");
  const metaText = (value) => String(value).replace(/[<>"']/gu, ' ').replace(/\s+/gu, ' ').trim();
  const pageTitle = metaText(title ? `${title} | JT Studio` : siteTitle);
  const metaDescription = metaText(description || defaultDescription);
  const imageDimensions = imageWidth && imageHeight ? [imageWidth, imageHeight] : [1200, 630];
  const headData = useContext(HeadDataContext);

  const businessSchema = {
    "@context": "https://schema.org",
    "@type": "BeautySalon",
    name: "Jaqueline Takiuti Studio",
    alternateName: "JT Studio",
    url: siteUrl,
    logo: `${siteUrl}/favicon.png`,
    image: defaultImage,
    description:
      "Micropigmentação, Nanoblading e Estética Avançada no JT Studio em Setúbal. Avaliação 4.9★ no Google. Agende já a sua sessão.",
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
    areaServed: [
      { "@type": "City", name: "Setúbal" },
      { "@type": "City", name: "Palmela" },
      { "@type": "City", name: "Azeitão" },
      { "@type": "City", name: "Sesimbra" },
      { "@type": "City", name: "Pinhal Novo" },
    ],
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: "4.9",
      bestRating: "5",
      ratingCount: 100,
    },
    openingHoursSpecification: {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      opens: "09:00",
      closes: "20:00",
    },
    potentialAction: {
      "@type": "ReserveAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: "https://www.sumupbookings.com/takiuti-studio",
        actionPlatform: "http://schema.org/DesktopWebPlatform",
      },
      result: {
        "@type": "Reservation",
        name: "Agendar sessão",
      },
    },
  };

  const breadcrumbSchema =
    canonicalPathname !== "/"
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
    canonicalPathname === "/"
      ? {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "JT Studio",
          url: siteUrl,
          inLanguage: "pt-PT",
        }
      : null;
  const schemas = [businessSchema, breadcrumbSchema, websiteSchema, structuredData].filter(Boolean);
  const schemaPayload = JSON.stringify(schemas);

  if (headData && typeof document === "undefined") {
    for (const schema of schemas) {
      const encoded = JSON.stringify(schema);
      if (!headData.some((entry) => JSON.stringify(entry) === encoded)) headData.push(schema);
    }
  }

  useEffect(() => {
    document.head.querySelectorAll('script[data-jt-jsonld="true"]').forEach((node) => node.remove());
    for (const schema of JSON.parse(schemaPayload)) {
      const script = document.createElement("script");
      script.type = "application/ld+json";
      script.dataset.jtJsonld = "true";
      script.textContent = safeJson(schema);
      document.head.append(script);
    }
    return () => document.head.querySelectorAll('script[data-jt-jsonld="true"]').forEach((node) => node.remove());
  }, [schemaPayload]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const robots = [...document.head.querySelectorAll('meta[name="robots"]')];
      if (shouldNoindex) {
        const meta = robots[0] ?? document.createElement('meta');
        meta.name = 'robots';
        meta.content = 'noindex, nofollow';
        if (!meta.parentNode) document.head.append(meta);
        robots.slice(1).forEach((node) => node.remove());
      } else {
        robots.forEach((node) => node.remove());
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [shouldNoindex]);

  return (
    <Helmet>
      <title>{pageTitle}</title>
      <meta name="description" content={metaDescription} />
      <link rel="canonical" href={canonicalUrl} />
      {shouldNoindex && <meta name="robots" content="noindex, nofollow" />}

      {/* Localização e Autor */}
      <meta name="author" content="Jaqueline Takiuti Studio" />
      <meta name="geo.region" content="PT-15" />
      <meta name="geo.placename" content="Setúbal" />
      <meta name="geo.position" content="38.532176;-8.898165" />
      <meta name="ICBM" content="38.532176, -8.898165" />
      <meta name="theme-color" content="#be185d" />

      {/* Open Graph */}
      <meta property="og:type" content={type} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:title" content={pageTitle} />
      <meta
        property="og:description"
        content={metaDescription}
      />
      <meta property="og:image" content={image || defaultImage} />
      <meta property="og:image:width" content={String(imageDimensions[0])} />
      <meta property="og:image:height" content={String(imageDimensions[1])} />
      <meta property="og:locale" content="pt_PT" />
      <meta property="og:site_name" content="JT Studio" />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={pageTitle} />
      <meta
        name="twitter:description"
        content={metaDescription}
      />
      <meta name="twitter:image" content={image || defaultImage} />

      {/* Structured Data */}
    </Helmet>
  );
};

export default SEO;
