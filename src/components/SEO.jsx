import { Helmet } from "react-helmet-async";

const SEO = ({ title, description }) => {
  const siteTitle = "JT Studio | Microblading & Estética";
  const defaultDescription =
    "Realce a sua beleza natural com Microblading, Nanoblading e Estética Avançada no JT Studio. Agende já a sua sessão.";

  return (
    <Helmet>
      <title>{title ? `${title} | JT Studio` : siteTitle}</title>
      <meta name="description" content={description || defaultDescription} />
      <meta property="og:type" content="website" />
      <meta
        property="og:title"
        content={title ? `${title} | JT Studio` : siteTitle}
      />
      <meta
        property="og:description"
        content={description || defaultDescription}
      />
      {/* Add more meta tags as needed (e.g. twitter cards, image) */}
    </Helmet>
  );
};

export default SEO;
