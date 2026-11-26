Pod::Spec.new do |s|
  s.name           = 'StoreAgeSignal'
  s.version        = '1.0.0'
  s.summary        = 'App Store age range signal for Union Ground account creation'
  s.description    = 'Asks Apple Declared Age Range for the signed-in Apple Account age range at the 18 gate and reports it as plain values.'
  s.author         = 'Union Ground'
  s.homepage       = 'https://unionground.org'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Declared Age Range exists from iOS 26; the module weak-links it and reports
  # "unavailable" on older systems.
  s.weak_frameworks = 'DeclaredAgeRange'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
