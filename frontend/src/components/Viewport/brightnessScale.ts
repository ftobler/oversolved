// Pure log-scale mapping between the Brightness slider's track position
// (-1 .. 0 .. 1) and the real toneMappingExposure value (0.25 .. 1 .. 4).
// The store and persisted record keep the real value; only the input's thumb
// lives on the track position.
export {
  MIN_BRIGHTNESS,
  MAX_BRIGHTNESS,
  BRIGHTNESS_STEP,
  brightnessToSlider,
  sliderToBrightness,
  snapBrightness,
} from '@/adapters/preferences'
