// Original ray marcher for the White/Nylander spherical-power Mandelbulb.
// Mathematical reference: https://paulbourke.org/fractals/bulb/
struct Camera { eye:vec4<f32>, right:vec4<f32>, up:vec4<f32>, forward:vec4<f32>, screen:vec4<f32>, settings:vec4<f32>, light:vec4<f32> }
@group(0) @binding(0) var<uniform> camera:Camera;
@vertex fn vertex_main(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
    let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));return vec4<f32>(p[i],0,1);
}
// Distance estimate and orbit trap for material color.
fn bulb(p:vec3<f32>)->vec2<f32> {
    var z=p; var derivative=1.0;var radius=0.0;var trap=1.0;
    let power=camera.settings.x;
    for(var i=0u;i<24u;i++) {
        if(f32(i)>=camera.settings.y){break;}
        radius=length(z);trap=min(trap,radius);
        if(radius>4.0){break;}
        if(radius<1e-7){return vec2<f32>(0.0,trap);}
        let theta=acos(clamp(z.y/radius,-1.0,1.0))*power;
        let phi=atan2(z.z,z.x)*power;
        let raised=pow(radius,power-1.0);
        derivative=raised*power*derivative+1.0;
        z=radius*raised*vec3<f32>(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi))+p;
    }
    return vec2<f32>(max(0.0,0.5*log(max(radius,1e-7))*radius/derivative),trap);
}
fn normal_at(p:vec3<f32>,e:f32)->vec3<f32> {
    let a=vec3<f32>(1,-1,-1);let b=vec3<f32>(-1,-1,1);let c=vec3<f32>(-1,1,-1);let d=vec3<f32>(1,1,1);
    let gradient=a*bulb(p+a*e).x+b*bulb(p+b*e).x+c*bulb(p+c*e).x+d*bulb(p+d*e).x;
    if(dot(gradient,gradient)<1e-20){return vec3<f32>(0,1,0);}
    return normalize(gradient);
}
// Secondary rays estimate visibility toward the moving area light.
fn soft_shadow(origin:vec3<f32>, direction:vec3<f32>, maximum:f32, bias:f32)->f32 {
    var visibility=1.0;var t=bias;
    for(var i=0u;i<40u;i++) {
        if(f32(i)>=camera.light.w || t>=maximum){break;}
        if(length(origin+direction*t)>2.0){break;}
        let distance=bulb(origin+direction*t).x;
        visibility=min(visibility,12.0*distance/max(t,bias));
        if(visibility<0.01){return 0.0;}
        t+=clamp(distance*0.8,bias,0.15);
    }
    return clamp(visibility,0.0,1.0);
}
@fragment fn fragment_main(@builtin(position) pixel:vec4<f32>)->@location(0) vec4<f32> {
    let uv=vec2<f32>(2.0*pixel.x-camera.screen.x,camera.screen.y-2.0*pixel.y)/camera.screen.y;
    let ray=normalize(camera.forward.xyz+camera.screen.z*(uv.x*camera.right.xyz+uv.y*camera.up.xyz));
    let eye=camera.eye.xyz;
    let sky=mix(vec3<f32>(0.014,0.025,0.044),vec3<f32>(0.065,0.10,0.15),clamp(ray.y*0.5+0.5,0.0,1.0));
    // Restrict expensive marching to the sphere containing the bulb.
    let b=dot(eye,ray);let discriminant=b*b-dot(eye,eye)+4.0;
    if(discriminant<0.0){return vec4<f32>(sky,1);}
    var travel=max(0.0,-b-sqrt(discriminant));let far=-b+sqrt(discriminant);
    if(far<0.0){return vec4<f32>(sky,1);}
    var hit=false;var epsilon=0.0001;var trap=0.0;
    for(var i=0u;i<224u;i++) {
        if(f32(i)>=camera.settings.z || travel>far){break;}
        epsilon=max(0.000001,travel*camera.screen.z/camera.screen.y*camera.settings.w);
        let sample=bulb(eye+ray*travel);trap=sample.y;
        if(sample.x<epsilon){hit=true;break;}
        travel+=max(sample.x*0.7,epsilon*0.25);
    }
    if(!hit){return vec4<f32>(sky,1);}
    let p=eye+ray*travel;let n=normal_at(p,max(epsilon*1.5,0.000002));
    let to_light=camera.light.xyz-p;
    let light=normalize(to_light);
    let bias=max(epsilon*4.0,0.00001);
    var shadow=0.0;
    if(dot(n,light)>0.0){shadow=soft_shadow(p+n*bias,light,length(to_light),bias);}
    let diffuse=max(dot(n,light),0.0);let fill=max(dot(n,normalize(vec3<f32>(0.8,0.1,-0.5))),0.0);
    var occlusion=0.0;
    for(var j=1u;j<=3u;j++) {let h=f32(j)*0.025;occlusion+=(h-bulb(p+n*h).x)/h;}
    let ao=clamp(1.0-occlusion*0.22,0.2,1.0);
    let metal=mix(vec3<f32>(0.08,0.38,0.46),vec3<f32>(0.94,0.62,0.27),smoothstep(0.15,0.85,trap));
    let highlight=pow(max(dot(n,normalize(light-ray)),0.0),40.0);
    let rim=pow(1.0-max(dot(n,-ray),0.0),3.0);
    var color=metal*(0.12+diffuse*1.3*shadow+fill*0.18)*ao+vec3<f32>(0.9,0.95,1.0)*highlight*0.45*shadow+vec3<f32>(0.12,0.23,0.3)*rim*ao;
    color=mix(color,sky,1.0-exp(-travel*0.045));
    return vec4<f32>(pow(max(color,vec3<f32>(0)),vec3<f32>(0.8)),1);
}
