Pod::Spec.new do |s|
  s.name           = 'NetworkPolicy'
  s.version        = '1.0.0'
  s.summary        = 'System network path signals for Union Ground low data mode'
  s.description    = 'Reports the operating system path reading (usable, expensive, Low Data Mode) without probing the network.'
  s.author         = 'Union Ground'
  s.homepage       = 'https://unionground.org'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
