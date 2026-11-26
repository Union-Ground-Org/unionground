Pod::Spec.new do |s|
  s.name           = 'SecureShareIntake'
  s.version        = '0.1.0'
  s.summary        = 'Privacy-safe local staging for native share intake'
  s.description    = 'Moves one bounded OS-shared file into short-lived app-owned storage.'
  s.author         = 'Union Ground'
  s.homepage       = 'https://unionground.org'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
