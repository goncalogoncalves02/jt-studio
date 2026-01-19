import { Helmet } from "react-helmet-async";

const SEO = ({ title, description, image, url }) => {
  const siteTitle = "JT Studio | Micropigmentação & Estética";
  const defaultDescription =
    "Realce a sua beleza natural com Microblading, Nanoblading e Estética Avançada no JT Studio. Agende já a sua sessão.";
  const siteUrl = "https://jaquelinetakiustudio.com";
  const defaultImage = `${siteUrl}/og-image.png`; // A tal imagem de 1200x630 que criaste

  return (
    <Helmet>
      {/* Título e Descrição */}
      <title>{title ? `${title} | JT Studio` : siteTitle}</title>
      <meta name="description" content={description || defaultDescription} />
      <link rel="canonical" href={url || siteUrl} />

      {/* Open Graph / Facebook / WhatsApp */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={url || siteUrl} />
      <meta
        property="og:title"
        content={title ? `${title} | JT Studio` : siteTitle}
      />
      <meta
        property="og:description"
        content={description || defaultDescription}
      />
      <meta property="og:image" content={image || defaultImage} />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta
        name="twitter:title"
        content={title ? `${title} | JT Studio` : siteTitle}
      />
      <meta
        name="twitter:description"
        content={description || defaultDescription}
      />
      <meta name="twitter:image" content={image || defaultImage} />
    </Helmet>
  );
};

export default SEO;
