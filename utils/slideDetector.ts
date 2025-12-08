// Utility functions for slide change detection
export class SlideDetector {
  private referenceImageData: ImageData | null = null;
  private slideStartTime: number | null = null;
  private threshold: number;

  constructor(threshold: number = 0.15) {
    this.threshold = threshold;
  }

  /**
   * Initialize with the first frame
   */
  setReferenceFrame(imageData: ImageData, timestamp: number): void {
    this.referenceImageData = imageData;
    this.slideStartTime = timestamp;
  }

  /**
   * Compare current frame with reference frame
   * Returns the difference score (0 = identical, 1 = completely different)
   */
  private calculateImageDifference(imageData1: ImageData, imageData2: ImageData): number {
    if (imageData1.width !== imageData2.width || imageData1.height !== imageData2.height) {
      return 1; // Completely different if dimensions don't match
    }

    const data1 = imageData1.data;
    const data2 = imageData2.data;
    let totalDifference = 0;
    const totalPixels = data1.length / 4; // 4 values per pixel (RGBA)

    for (let i = 0; i < data1.length; i += 4) {
      // Calculate RGB difference (ignore alpha channel)
      const rDiff = Math.abs(data1[i] - data2[i]);
      const gDiff = Math.abs(data1[i + 1] - data2[i + 1]);
      const bDiff = Math.abs(data1[i + 2] - data2[i + 2]);
      
      // Average RGB difference for this pixel
      const pixelDifference = (rDiff + gDiff + bDiff) / (3 * 255);
      totalDifference += pixelDifference;
    }

    return totalDifference / totalPixels;
  }

  /**
   * Check if current frame represents a slide change
   * Returns object with change detection results
   */
  detectSlideChange(currentImageData: ImageData, currentTimestamp: number): {
    isChange: boolean;
    difference: number;
    slideDuration: number | null;
    previousSlideStartTime: number | null;
  } {
    if (!this.referenceImageData || !this.slideStartTime) {
      // First frame - set as reference
      this.setReferenceFrame(currentImageData, currentTimestamp);
      return {
        isChange: false,
        difference: 0,
        slideDuration: null,
        previousSlideStartTime: null,
      };
    }

    const difference = this.calculateImageDifference(this.referenceImageData, currentImageData);
    const isChange = difference > this.threshold;

    if (isChange) {
      const slideDuration = currentTimestamp - this.slideStartTime;
      const previousSlideStartTime = this.slideStartTime;
      
      // Update reference for next comparison
      this.setReferenceFrame(currentImageData, currentTimestamp);
      
      return {
        isChange: true,
        difference,
        slideDuration,
        previousSlideStartTime,
      };
    }

    return {
      isChange: false,
      difference,
      slideDuration: null,
      previousSlideStartTime: null,
    };
  }

  /**
   * Get current slide duration
   */
  getCurrentSlideDuration(currentTimestamp: number): number {
    if (!this.slideStartTime) return 0;
    return currentTimestamp - this.slideStartTime;
  }

  /**
   * Reset the detector
   */
  reset(): void {
    this.referenceImageData = null;
    this.slideStartTime = null;
  }
}
