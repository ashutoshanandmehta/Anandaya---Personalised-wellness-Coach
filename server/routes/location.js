/**
 * location.js — Phase 6: Maps Integration
 *
 * Endpoint:
 *   POST /api/location/nearby-care
 *     Body: { lat, lng, type? }
 *     Returns: nearby hospitals, clinics, pharmacies
 *
 * Uses Google Places API (Nearby Search) if GOOGLE_PLACES_API_KEY is set.
 * Falls back to a curated mock dataset so the architecture is always functional.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = Router();
router.use(requireAuth);

// ── Mock Data (India-focused fallback) ──────────────────────────
const MOCK_PLACES = [
  {
    place_id: 'mock_001',
    name: 'Apollo Hospitals',
    vicinity: 'Greams Road, Chennai',
    rating: 4.5,
    user_ratings_total: 2847,
    types: ['hospital', 'health'],
    geometry: { location: { lat: 13.0604, lng: 80.2496 } },
    opening_hours: { open_now: true },
    icon: 'https://maps.gstatic.com/mapfiles/place_api/icons/v1/png_71/hospital-71.png',
    phone: '+91 44 2829 0200',
  },
  {
    place_id: 'mock_002',
    name: 'Fortis Healthcare',
    vicinity: 'Sector 62, Noida',
    rating: 4.3,
    user_ratings_total: 1923,
    types: ['hospital', 'health'],
    geometry: { location: { lat: 28.6271, lng: 77.3723 } },
    opening_hours: { open_now: true },
    icon: 'https://maps.gstatic.com/mapfiles/place_api/icons/v1/png_71/hospital-71.png',
    phone: '+91 120 496 6000',
  },
  {
    place_id: 'mock_003',
    name: 'MedPlus Pharmacy',
    vicinity: 'Koramangala, Bangalore',
    rating: 4.1,
    user_ratings_total: 641,
    types: ['pharmacy', 'health'],
    geometry: { location: { lat: 12.9279, lng: 77.6271 } },
    opening_hours: { open_now: true },
    icon: 'https://maps.gstatic.com/mapfiles/place_api/icons/v1/png_71/pharmacy-71.png',
    phone: '+91 40 4242 4242',
  },
  {
    place_id: 'mock_004',
    name: 'Max Super Speciality Hospital',
    vicinity: 'Saket, New Delhi',
    rating: 4.4,
    user_ratings_total: 3102,
    types: ['hospital', 'health'],
    geometry: { location: { lat: 28.5245, lng: 77.2066 } },
    opening_hours: { open_now: true },
    icon: 'https://maps.gstatic.com/mapfiles/place_api/icons/v1/png_71/hospital-71.png',
    phone: '+91 11 2651 5050',
  },
  {
    place_id: 'mock_005',
    name: 'Columbia Asia Hospital',
    vicinity: 'Whitefield, Bangalore',
    rating: 4.2,
    user_ratings_total: 876,
    types: ['hospital', 'health'],
    geometry: { location: { lat: 12.9718, lng: 77.7500 } },
    opening_hours: { open_now: false },
    icon: 'https://maps.gstatic.com/mapfiles/place_api/icons/v1/png_71/hospital-71.png',
    phone: '+91 80 6745 6789',
  },
  {
    place_id: 'mock_006',
    name: 'Dr. Lal PathLabs',
    vicinity: 'Connaught Place, New Delhi',
    rating: 4.3,
    user_ratings_total: 589,
    types: ['doctor', 'health'],
    geometry: { location: { lat: 28.6315, lng: 77.2167 } },
    opening_hours: { open_now: true },
    icon: 'https://maps.gstatic.com/mapfiles/place_api/icons/v1/png_71/generic_business-71.png',
    phone: '+91 11 3988 7777',
  },
];

// ── Places API Integration ──────────────────────────────────────

async function fetchFromGooglePlaces(lat, lng, type, radius) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  const placeType = type === 'pharmacy' ? 'pharmacy' : 'hospital';
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${placeType}&key=${apiKey}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') return null;
    return data.results || [];
  } catch (e) {
    console.error('[Places API] fetch error:', e.message);
    return null;
  }
}

function addMockDistance(place, lat, lng) {
  // Haversine distance in km for display
  const R = 6371;
  const pLat = place.geometry?.location?.lat || lat;
  const pLng = place.geometry?.location?.lng || lng;
  const dLat = ((pLat - lat) * Math.PI) / 180;
  const dLng = ((pLng - lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat * Math.PI) / 180) * Math.cos((pLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = R * c;

  return {
    ...place,
    distance_km: Math.round(distanceKm * 10) / 10,
    maps_url: `https://www.google.com/maps/dir/?api=1&destination=${pLat},${pLng}&destination_place_id=${place.place_id || ''}`,
  };
}

// ── POST /api/location/nearby-care ─────────────────────────────
router.post('/location/nearby-care', async (req, res) => {
  try {
    const { lat, lng, type = 'hospital', radius = 5000 } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    // Try real Google Places API first
    const realResults = await fetchFromGooglePlaces(lat, lng, type, radius);

    if (realResults && realResults.length > 0) {
      const enriched = realResults.slice(0, 8).map(p => addMockDistance(p, lat, lng));
      return res.json({
        source: 'google_places',
        type,
        count: enriched.length,
        results: enriched,
      });
    }

    // Fallback: return curated mock data with realistic distances added
    const mockResults = MOCK_PLACES
      .filter(p => type === 'pharmacy' ? p.types.includes('pharmacy') : true)
      .map(p => addMockDistance(p, lat, lng))
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, 6);

    return res.json({
      source: 'mock_data',
      type,
      count: mockResults.length,
      results: mockResults,
      note: process.env.GOOGLE_PLACES_API_KEY
        ? 'Live results unavailable — showing representative data.'
        : 'Set GOOGLE_PLACES_API_KEY in .env for real nearby results.',
    });

  } catch (error) {
    console.error('[Location]', error);
    res.status(500).json({ error: 'Location lookup failed. Please try again.' });
  }
});

export default router;
