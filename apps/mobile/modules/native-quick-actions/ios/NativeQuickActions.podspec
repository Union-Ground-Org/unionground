Pod::Spec.new do |s|
  s.name           = 'NativeQuickActions'
  s.version        = '1.0.0'
  s.summary        = 'Privacy-safe Union Ground operating-system quick actions'
  s.description    = 'Consumes fixed, parameterless App Shortcut destinations without protected data.'
  s.author         = 'Union Ground'
  s.homepage       = 'https://unionground.org'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
