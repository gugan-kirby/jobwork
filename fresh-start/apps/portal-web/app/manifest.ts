import type { MetadataRoute } from 'next';
import brand from '@jobwork/ui/brand.json';

/**
 * The installable portal (F-11.6; doc 21 §8; ADR-0005). Customers and suppliers open
 * JobWork from a phone's home screen like an app; it is still the same site, with the
 * same sign-in and nothing stored on the device but the offline page and code.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'JobWork',
    short_name: 'JobWork',
    description: 'Custom manufacturing, from enquiry to delivery.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: brand.backgroundColor,
    theme_color: brand.themeColor,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
