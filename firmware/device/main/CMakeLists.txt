idf_component_register(
  SRCS main.cpp board.cpp power.cpp device_hal.cpp network.cpp audio.cpp
  INCLUDE_DIRS .
  REQUIRES charm_core esp_lcd esp_driver_gpio esp_driver_i2c esp_driver_spi esp_driver_tsens esp_driver_i2s
           esp_timer esp_app_format nvs_flash log mbedtls)
# Waveshare's touch config macro leaves fields to their defaults, as XiaoZhi tolerates too.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-missing-field-initializers)
# The board's full CJK font (spec 016): a binary LVGL font in flash, loaded at start.
target_add_binary_data(${COMPONENT_LIB}
  "../../core/src/ui/fonts/charm_cjk_24_full.bin" BINARY)
